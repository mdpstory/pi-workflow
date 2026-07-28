/**
 * Subagent tool — child-process spawn/env/lifecycle.
 *
 * Owns: env construction for spawned children (identity + recursion-depth
 * security model), the actual `pi --mode json` spawn/stream loop, and the
 * shared result/usage types. See tool.ts for the registered tool surface
 * (execute/renderCall/renderResult) and format.ts for display helpers.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope } from "./agents.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface LiveToolCall {
	name: string;
	rawArgs: string;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Reserved env keys the caller tried to set (PI_WORKFLOW_ROLE etc.) — silently dropped otherwise (P0-1). */
	droppedEnvKeys?: string[];
	/** In-progress text the model is currently emitting (word-by-word), cleared once folded into messages. */
	liveText?: string;
	/** In-progress tool call whose arguments are still streaming in (e.g. a `write` mid-generation). */
	liveToolCall?: LiveToolCall;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

const RATE_LIMIT_PATTERNS = [
	/\b429\b/,
	/rate.?limit/i,
	/too many requests/i,
	/quota exceeded/i,
	/request limit/i,
	/overloaded/i,
];

/**
 * Detect whether a subagent result indicates a rate-limit error.
 * Checks both the structured errorMessage and raw stderr.
 */
export function detectRateLimit(result: SingleResult): boolean {
	const text = [result.errorMessage, result.stderr].filter(Boolean).join(" ");
	return RATE_LIMIT_PATTERNS.some((p) => p.test(text));
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

/**
 * Env keys that encode *identity and safety limits*, never user data. These are set
 * exclusively by buildChildEnv from things the extension controls (which agent was
 * dispatched, how deep we already are) and are stripped from caller-supplied `env`.
 *
 * Why: `env` is tool input, i.e. model-controlled. If a caller could set
 * PI_WORKFLOW_ROLE it could dispatch `{agent:"engineer", env:{PI_WORKFLOW_ROLE:"director"}}`
 * and hand the child director permissions — identity would still be a thing the model
 * asserts rather than a thing the harness enforces, which is exactly the hole that made
 * the task-text convention useless. Same for PI_SUBAGENT_DEPTH: a caller resetting it to
 * "0" would defeat the recursion ceiling outright.
 *
 * Consequence (intended): identity derives from *which agent was dispatched*, via the
 * agent's declared `workflowRole` frontmatter. Callers do not pass roles at all.
 */
export const RESERVED_ENV_KEYS = new Set([
	"PI_WORKFLOW_ROLE",
	"PI_WORKFLOW_ID",
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_CHAIN",
	"PI_SUBAGENT_SELF_AGENT",
	"PI_SUBAGENT_PARENT_AGENT",
	"PI_SUBAGENT_MAX_DEPTH",
]);

function readActiveWorkflowId(cwd: string): string | undefined {
	try {
		return fs.readFileSync(path.join(cwd, ".workflow", ".active-id"), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Builds the env for a spawned child, or returns an error if the recursion
 * depth ceiling would be exceeded.
 *
 * Precedence (low to high): inherited process.env -> caller-supplied extraEnv
 * (minus RESERVED_ENV_KEYS) -> depth/chain bookkeeping -> agent-declared
 * workflowRole -> auto-resolved PI_WORKFLOW_ID.
 *
 * Note the caller sits *below* the identity layer, not above it: reserved keys are
 * dropped from extraEnv before it is merged, so no tool input can assign a role,
 * retarget a workflow namespace, or reset the recursion counter. See RESERVED_ENV_KEYS.
 *
 * `childCwd` is the directory the child will actually run in (`cwd ?? defaultCwd` at
 * the spawn site) — the .workflow/.active-id marker must be resolved against *that*,
 * not against the parent's cwd, or a task with a `cwd` override into another repo
 * inherits this repo's workflow id and writes artifacts into a namespace that does
 * not exist there.
 */
export function buildChildEnv(
	childCwd: string,
	agentName: string,
	agent: AgentConfig,
	extraEnv: Record<string, string> | undefined,
): { env: NodeJS.ProcessEnv; droppedKeys: string[]; error?: undefined } | { env?: undefined; droppedKeys?: undefined; error: string } {
	const parentDepth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
	const maxDepth = Number.parseInt(process.env.PI_SUBAGENT_MAX_DEPTH ?? "", 10) || DEFAULT_MAX_SUBAGENT_DEPTH;
	const childDepth = parentDepth + 1;
	const parentChain = process.env.PI_SUBAGENT_CHAIN;
	const chain = parentChain ? `${parentChain} > ${agentName}` : agentName;

	if (childDepth > maxDepth) {
		return { error: `Refused: subagent recursion depth exceeded (max ${maxDepth}). Chain: ${chain}` };
	}

	const env: NodeJS.ProcessEnv = {
		...process.env,
	};

	// Caller-supplied env first, with identity/limit keys stripped — it may not
	// override anything set below. Track which reserved keys were dropped so the
	// caller can be warned instead of silently ignored (P0-1).
	const droppedKeys: string[] = [];
	if (extraEnv) {
		for (const [k, v] of Object.entries(extraEnv)) {
			if (RESERVED_ENV_KEYS.has(k)) {
				droppedKeys.push(k);
				continue;
			}
			env[k] = v;
		}
	}

	Object.assign(env, {
		PI_SUBAGENT_DEPTH: String(childDepth),
		PI_SUBAGENT_PARENT_AGENT: process.env.PI_SUBAGENT_SELF_AGENT ?? "root",
		PI_SUBAGENT_SELF_AGENT: agentName,
		PI_SUBAGENT_CHAIN: chain,
	});

	// Identity comes from the dispatched agent's declaration, never from tool input.
	// An agent with no `workflowRole` frontmatter (e.g. `worker`) gets no role at all —
	// the inherited value is cleared so it can't masquerade as its parent.
	if (agent.workflowRole) env.PI_WORKFLOW_ROLE = agent.workflowRole;
	else delete env.PI_WORKFLOW_ROLE;

	const workflowId = process.env.PI_WORKFLOW_ID ?? readActiveWorkflowId(childCwd);
	if (workflowId) env.PI_WORKFLOW_ID = workflowId;

	return { env, droppedKeys };
}

export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	overrideModel: string | undefined,
	extraEnv: Record<string, string> | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	/** Parent's model — used as fallback when subagent model is rate-limited. */
	parentModel: string | undefined,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const depthCheck = buildChildEnv(cwd ?? defaultCwd, agentName, agent, extraEnv);
	if (depthCheck.error) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: depthCheck.error,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}
	const childEnv = depthCheck.env;
	const droppedEnvKeys = depthCheck.droppedKeys;

	const selectedModel = overrideModel || agent.model;

	const emitUpdate = (result: SingleResult) => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
				details: makeDetails([result]),
			});
		}
	};

	// Streaming deltas arrive many times per second; throttle UI pushes so we
	// don't hammer the terminal renderer while still feeling "live".
	const LIVE_THROTTLE_MS = 80;
	let lastLiveEmit = 0;
	const emitLiveUpdate = (result: SingleResult) => {
		const now = Date.now();
		if (now - lastLiveEmit < LIVE_THROTTLE_MS) return;
		lastLiveEmit = now;
		emitUpdate(result);
	};

	/**
	 * Spawn a child pi process with the given model and return the result.
	 * Extracted so we can retry with a different model on rate-limit.
	 */
	const spawnWithModel = async (model: string | undefined): Promise<SingleResult> => {
		const args: string[] = ["--mode", "json", "-p", "--no-session"];
		if (model) args.push("--model", model);
		if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

		const result: SingleResult = {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model,
			step,
		};

		const toolsLine = agent.tools?.length
			? `You only have access to these tools: ${agent.tools.join(", ")}. Do NOT attempt to call any other tool — the call will fail.`
			: "";
		const fullPrompt = [agent.systemPrompt.trim(), toolsLine].filter(Boolean).join("\n\n");
		let localTmpPromptDir: string | null = null;
		let localTmpPromptPath: string | null = null;
		if (fullPrompt) {
			const tmp = await writePromptToTempFile(agent.name, fullPrompt);
			localTmpPromptDir = tmp.dir;
			localTmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", localTmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		try {
			const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_update" && event.assistantMessageEvent) {
					const ev = event.assistantMessageEvent;
					switch (ev.type) {
						case "text_start":
						case "thinking_start":
							result.liveText = "";
							result.liveToolCall = undefined;
							break;
						case "text_delta":
						case "thinking_delta":
							result.liveText = (result.liveText ?? "") + (ev.delta ?? "");
							emitLiveUpdate(result);
							break;
						case "text_end":
						case "thinking_end":
							result.liveText = undefined;
							break;
						case "toolcall_start": {
							const partialItem = ev.partial?.content?.[ev.contentIndex];
							if (!result.liveToolCall) {
								result.liveToolCall = { name: partialItem?.name ?? "", rawArgs: "" };
							}
							result.liveText = undefined;
							break;
						}
						case "toolcall_delta": {
							if (result.liveToolCall) {
								result.liveToolCall.rawArgs += ev.delta ?? "";
								emitLiveUpdate(result);
							}
							break;
						}
						case "toolcall_end":
							result.liveToolCall = undefined;
							emitUpdate(result);
							break;
					}
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);
					result.liveText = undefined;
					result.liveToolCall = undefined;

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					emitUpdate(result);
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					emitUpdate(result);
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

			result.exitCode = exitCode;
			if (wasAborted) throw new Error("Subagent was aborted");
			return result;
		} finally {
			if (localTmpPromptPath)
				try {
					fs.unlinkSync(localTmpPromptPath);
				} catch {
					/* ignore */
				}
			if (localTmpPromptDir)
				try {
					fs.rmdirSync(localTmpPromptDir);
				} catch {
					/* ignore */
				}
		}
	};

	let result = await spawnWithModel(selectedModel);

	// Rate-limit fallback: if the chosen model was rate-limited and we have
	// a different parent model available, retry once with that model.
	if (
		detectRateLimit(result) &&
		parentModel &&
		parentModel !== selectedModel
	) {
		result = await spawnWithModel(parentModel);
	}

	if (droppedEnvKeys.length > 0) {
		result.droppedEnvKeys = droppedEnvKeys;
		const warning = `pi-workflow: ignored reserved env key(s) from caller: ${droppedEnvKeys.join(", ")}. Identity comes from the dispatched agent's workflowRole frontmatter, not caller-supplied env — this had no effect.`;
		result.stderr = result.stderr ? `${warning}\n${result.stderr}` : warning;
	}

	return result;
}
