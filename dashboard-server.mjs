/**
 * pi-workflow dashboard server
 * Port 4242, shared across all workflow sessions.
 * Sessions POST /update, /activity, /heartbeat; browser connects to /events (SSE).
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4242;
const HEARTBEAT_TTL = 30_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "dashboard.html");

const sessions = new Map(); // cwd → session
const sseClients = new Set();

function isFinished(session) {
	const stages = Object.values(session.state?.stages ?? {});
	return stages.length > 0 && stages.every((s) => s.status === "done" || s.status === "failed");
}

function broadcastSessions() {
	const payload = JSON.stringify([...sessions.values()]);
	const msg = `data: ${payload}\n\n`;
	for (const res of sseClients) {
		try { res.write(msg); } catch {}
	}
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
		req.on("error", reject);
	});
}

// Drop stale non-finished sessions every 15s
setInterval(() => {
	const now = Date.now();
	let changed = false;
	for (const [cwd, s] of sessions) {
		if (!isFinished(s) && now - new Date(s.lastSeen).getTime() > HEARTBEAT_TTL) {
			sessions.delete(cwd);
			changed = true;
		}
	}
	if (changed) broadcastSessions();
}, 15_000);

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	res.setHeader("Access-Control-Allow-Origin", "*");

	if (req.method === "GET" && url.pathname === "/ping") {
		res.writeHead(200).end("ok");
		return;
	}

	if (req.method === "GET" && url.pathname === "/") {
		try {
			const html = fs.readFileSync(HTML_PATH);
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
		} catch {
			res.writeHead(500).end("dashboard.html not found");
		}
		return;
	}

	if (req.method === "GET" && url.pathname === "/events") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
		});
		res.write(`data: ${JSON.stringify([...sessions.values()])}\n\n`);
		sseClients.add(res);
		req.on("close", () => sseClients.delete(res));
		return;
	}

	if (req.method === "POST" && url.pathname === "/update") {
		const body = await readBody(req);
		if (!body.cwd) { res.writeHead(400).end("missing cwd"); return; }
		const existing = sessions.get(body.cwd) ?? {};
		sessions.set(body.cwd, {
			...existing,
			...body,
			lastSeen: new Date().toISOString(),
			finished: isFinished(body),
		});
		broadcastSessions();
		res.writeHead(200).end("ok");
		return;
	}

	if (req.method === "POST" && url.pathname === "/activity") {
		const body = await readBody(req);
		if (!body.cwd) { res.writeHead(400).end("missing cwd"); return; }
		const s = sessions.get(body.cwd);
		if (s) {
			s.activity = body.activity;
			s.toolCalls = body.toolCalls;
			s.lastSeen = new Date().toISOString();
			broadcastSessions();
		}
		res.writeHead(200).end("ok");
		return;
	}

	if (req.method === "POST" && url.pathname === "/heartbeat") {
		const body = await readBody(req);
		if (body.cwd && sessions.has(body.cwd)) {
			sessions.get(body.cwd).lastSeen = new Date().toISOString();
		}
		res.writeHead(200).end("ok");
		return;
	}

	res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`pi-workflow dashboard: http://localhost:${PORT}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
	process.on(sig, () => server.close(() => process.exit(0)));
}
