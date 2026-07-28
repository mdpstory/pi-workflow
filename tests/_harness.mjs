// Shared sandbox harness for the standalone tool-level tests.
// Not named *.test.mjs on purpose — `node --test tests/*.test.mjs` must not run it directly.
import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Boot the extension inside a throwaway sandbox cwd with stubbed pi modules.
 * @param {{ prefix?: string, config?: object, workflowId?: string }} opts
 */
export async function boot(opts = {}) {
	const { prefix = "wf-test-", config = {}, workflowId = "default" } = opts;
	process.env.PI_WORKFLOW_ID = workflowId;
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	process.env.HOME = sandbox; // isolate from the real ~/.pi/agent/pi-workflow.json
	process.chdir(sandbox);
	fs.mkdirSync(".pi", { recursive: true });
	fs.writeFileSync(".pi/pi-workflow.json", JSON.stringify(config));

	fs.writeFileSync(
		"__stub_pi_ai.mjs",
		`export const StringEnum = (v) => ({ type: "string", enum: v });
export const Type = {
  Object: (s) => ({ type: "object", properties: s }),
  String: (o) => ({ type: "string", ...o }),
  Optional: (t) => ({ ...t, optional: true }),
  Boolean: (o) => ({ type: "boolean", ...o }),
  Number: (o) => ({ type: "number", ...o }),
};`,
	);
	fs.writeFileSync("__stub_pi_agent.mjs", "export const isReadToolResult = () => false;");

	const tools = new Map();
	const hooks = new Map();
	const api = {
		registerTool: (t) => tools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (name, fn) => {
			if (!hooks.has(name)) hooks.set(name, []);
			hooks.get(name).push(fn);
		},
	};
	const jiti = createJiti(import.meta.url, {
		interopDefault: true,
		alias: {
			"@earendil-works/pi-ai": path.join(sandbox, "__stub_pi_ai.mjs"),
			"@earendil-works/pi-coding-agent": path.join(sandbox, "__stub_pi_agent.mjs"),
		},
	});
	const extModule = await jiti.import(new URL("../index.ts", import.meta.url).pathname);
	(extModule.default || extModule)(api);

	const call = async (name, params = {}, ctx) => {
		const t = tools.get(name);
		if (!t) throw new Error(`no tool: ${name}`);
		const r = await t.execute("id", params, undefined, undefined, ctx);
		return { ...r, text: r.content?.[0]?.text ?? "" };
	};
	const toolCall = async (toolName, input) => {
		for (const fn of hooks.get("tool_call") ?? []) {
			const r = await fn({ toolName, input }, {});
			if (r) return r;
		}
		return undefined;
	};
	const setRole = (r) => {
		process.env.PI_WORKFLOW_ROLE = r;
	};
	const wfId = () => process.env.PI_WORKFLOW_ID;
	const readState = () => JSON.parse(fs.readFileSync(`.workflow/${wfId()}/state.json`, "utf8"));
	const writeState = (s) => fs.writeFileSync(`.workflow/${wfId()}/state.json`, JSON.stringify(s));
	const artifact = (f, body) => fs.writeFileSync(path.join(`.workflow/${wfId()}/artifacts`, f), body);

	return { sandbox, tools, hooks, call, toolCall, setRole, readState, writeState, artifact };
}
