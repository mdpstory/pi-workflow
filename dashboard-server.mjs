/**
 * pi-workflow dashboard server
 * Runs on port 4242, shared across all workflow sessions.
 * Sessions POST /update and /heartbeat; browser connects to /events (SSE).
 */

import * as http from "node:http";

const PORT = 4242;
const HEARTBEAT_TTL = 30_000; // ms before a non-finished session is dropped

// Map<cwd, session>
const sessions = new Map();
// Set of SSE response objects
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
		req.on("data", (chunk) => (data += chunk));
		req.on("end", () => {
			try { resolve(JSON.parse(data)); } catch { resolve({}); }
		});
		req.on("error", reject);
	});
}

// Drop stale (non-finished) sessions every 15s
setInterval(() => {
	const now = Date.now();
	let changed = false;
	for (const [cwd, session] of sessions) {
		if (!isFinished(session) && now - new Date(session.lastSeen).getTime() > HEARTBEAT_TTL) {
			sessions.delete(cwd);
			changed = true;
		}
	}
	if (changed) broadcastSessions();
}, 15_000);

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pi-workflow dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; font-size: 14px; background: #f5f5f5; color: #111; padding: 20px; }
  h1 { font-size: 18px; margin-bottom: 16px; }
  #status { font-size: 12px; color: #888; margin-bottom: 16px; }
  .empty { color: #888; font-style: italic; }
  .cards { display: flex; flex-direction: column; gap: 16px; }
  .card { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 16px; }
  .card.finished { opacity: 0.5; }
  .card-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 12px; }
  .repo-name { font-size: 16px; font-weight: bold; }
  .repo-path { font-size: 11px; color: #888; }
  .badge { font-size: 11px; background: #eee; padding: 2px 6px; border-radius: 3px; }
  .badge.finished { background: #d0f0d0; }
  .section { margin-top: 12px; }
  .section-label { font-size: 11px; font-weight: bold; text-transform: uppercase; color: #888; margin-bottom: 6px; }
  .stages { display: flex; flex-wrap: wrap; gap: 6px; }
  .stage { padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; background: #fafafa; }
  .stage.current { border-color: #0070f3; background: #e8f0fe; font-weight: bold; }
  .stage.done { color: #555; }
  .stage.blocked { border-color: #f00; background: #fff0f0; }
  .stage.failed { border-color: #c00; background: #ffe0e0; }
  .budget { font-size: 12px; margin-top: 4px; }
  .budget-bar { display: inline-block; width: 120px; height: 8px; background: #eee; border-radius: 4px; vertical-align: middle; margin-right: 6px; overflow: hidden; }
  .budget-fill { height: 100%; background: #0070f3; border-radius: 4px; }
  .budget-fill.warn { background: #f90; }
  .budget-fill.danger { background: #f00; }
  .clr { font-size: 12px; padding: 4px 0; border-bottom: 1px solid #eee; }
  .clr:last-child { border-bottom: none; }
  .clr-id { font-weight: bold; }
  .artifacts { margin-top: 4px; }
  details { margin-top: 6px; }
  summary { cursor: pointer; font-size: 12px; font-weight: bold; color: #333; padding: 2px 0; }
  summary:hover { color: #0070f3; }
  pre { font-size: 11px; background: #f8f8f8; border: 1px solid #eee; border-radius: 4px; padding: 8px; margin-top: 4px; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; }
  .ts { font-size: 11px; color: #aaa; margin-top: 10px; }
</style>
</head>
<body>
<h1>pi-workflow</h1>
<div id="status">connecting...</div>
<div id="root"><p class="empty">No active workflows.</p></div>
<script>
const STAGES = ["planning","research","task-breakdown","architecture","implementation","review","testing","documentation"];
const STATUS_EMOJI = { todo:"⬜", "in-progress":"⏳", done:"✅", blocked:"🔴", retry:"🔁", failed:"❌" };

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function renderCard(s) {
  const finished = s.finished;
  const stages = s.state?.stages ?? {};
  const current = s.state?.current;
  const clrs = s.clr?.open ?? [];
  const artifacts = s.artifacts ?? {};
  const tc = s.toolCalls ?? 0;
  const cap = s.toolCap ?? 50;
  const pct = Math.min(100, Math.round(tc / cap * 100));
  const fillClass = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "";

  const stagesHtml = STAGES.map(name => {
    const st = stages[name] ?? { status: "todo" };
    const emoji = STATUS_EMOJI[st.status] || "?";
    const cls = ["stage", st.status === current ? "current" : "", st.status].filter(Boolean).join(" ");
    return \`<span class="\${cls}">\${emoji} \${esc(name)}</span>\`;
  }).join("");

  const clrHtml = clrs.length
    ? clrs.map(c => \`<div class="clr"><span class="clr-id">\${esc(c.id)}</span> [\${esc(c.stage)}] \${esc(c.question ?? "")}</div>\`).join("")
    : \`<div style="font-size:12px;color:#888">none</div>\`;

  const artifactHtml = Object.entries(artifacts)
    .filter(([, v]) => v && !v.includes("_empty_") && v.trim().length > 0)
    .map(([name, content]) => \`<details><summary>\${esc(name)}</summary><pre>\${esc(content)}</pre></details>\`)
    .join("");

  const ts = s.lastSeen ? new Date(s.lastSeen).toLocaleTimeString() : "";

  return \`
<div class="card\${finished ? " finished" : ""}">
  <div class="card-header">
    <span class="repo-name">\${esc(s.repoName)}</span>
    <span class="repo-path">\${esc(s.cwd)}</span>
    \${finished ? '<span class="badge finished">FINISHED</span>' : '<span class="badge">LIVE</span>'}
  </div>
  <div class="section">
    <div class="section-label">Stages</div>
    <div class="stages">\${stagesHtml}</div>
  </div>
  <div class="section">
    <div class="section-label">Tool budget</div>
    <div class="budget">
      <span class="budget-bar"><span class="budget-fill \${fillClass}" style="width:\${pct}%"></span></span>
      \${tc} / \${cap} tools this stage
    </div>
  </div>
  <div class="section">
    <div class="section-label">Open CLRs</div>
    \${clrHtml}
  </div>
  \${artifactHtml ? \`<div class="section"><div class="section-label">Artifacts</div><div class="artifacts">\${artifactHtml}</div></div>\` : ""}
  <div class="ts">Last update: \${ts}</div>
</div>\`;
}

function render(sessions) {
  const root = document.getElementById("root");
  if (!sessions.length) {
    root.innerHTML = '<p class="empty">No active workflows.</p>';
    return;
  }
  root.innerHTML = '<div class="cards">' + sessions.map(renderCard).join("") + '</div>';
}

const es = new EventSource("/events");
es.onopen = () => { document.getElementById("status").textContent = "connected"; };
es.onerror = () => { document.getElementById("status").textContent = "disconnected — retrying..."; };
es.onmessage = (e) => {
  try {
    const sessions = JSON.parse(e.data);
    render(sessions);
    document.getElementById("status").textContent = "live · " + new Date().toLocaleTimeString();
  } catch {}
};
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);

	// CORS for local dev
	res.setHeader("Access-Control-Allow-Origin", "*");

	if (req.method === "GET" && url.pathname === "/ping") {
		res.writeHead(200).end("ok");
		return;
	}

	if (req.method === "GET" && url.pathname === "/") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(DASHBOARD_HTML);
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
		const { cwd } = body;
		if (!cwd) { res.writeHead(400).end("missing cwd"); return; }
		const existing = sessions.get(cwd) ?? {};
		const session = {
			...existing,
			...body,
			lastSeen: new Date().toISOString(),
			finished: isFinished(body),
		};
		sessions.set(cwd, session);
		broadcastSessions();
		res.writeHead(200).end("ok");
		return;
	}

	if (req.method === "POST" && url.pathname === "/heartbeat") {
		const body = await readBody(req);
		const { cwd } = body;
		if (cwd && sessions.has(cwd)) {
			sessions.get(cwd).lastSeen = new Date().toISOString();
			// no broadcast needed for heartbeat
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
	process.on(sig, () => {
		server.close(() => process.exit(0));
	});
}
