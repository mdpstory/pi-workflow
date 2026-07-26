// ---- concurrency lock ----
// Detects "is a workflow already running in this dir" via PID liveness.
// Self-heals: if the PID that holds the lock is dead (session was killed /
// quit), the lock is considered stale and silently reclaimed — no manual
// unlock step needed after an abort.
// (C7) heartbeatAt field removed: it was never consulted for staleness — liveness is,
// and always was, PID-only (process.kill(pid, 0)). A field nobody reads is dead weight.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJson, writeJson } from "./io.ts";
import { lockPath } from "./paths.ts";

export interface LockInfo {
	pid: number;
	host: string;
	startedAt: string;
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// (P1-7) `process.kill(pid, 0)` only means anything against a PID on THIS host. A lock
// written on another machine (shared checkout / NFS mount) has a `pid` that is just a
// number here — an unrelated local process happening to reuse that PID reads back as
// "ALIVE" even though the real lock holder is on a different machine entirely, and the
// same false positive happens from PID reuse on one host after a long-dead process. Gate
// the local PID check behind a hostname match; a foreign host reports UNKNOWN instead of
// silently resolving either way.
export type LockLiveness = "alive" | "stale" | "unknown-foreign-host";
export function lockLiveness(lock: LockInfo): LockLiveness {
	if (lock.host !== os.hostname()) return "unknown-foreign-host";
	return isPidAlive(lock.pid) ? "alive" : "stale";
}

export function readLock(): LockInfo | null {
	return readJson<LockInfo | null>(lockPath(), null);
}

/** Returns null if lock acquired (or refreshed as our own), or the foreign
 *  LockInfo if another live process already holds it.
 *  Acquisition of a *new* lock (no existing file yet) uses `wx` exclusive-create to
 *  close the read-then-write TOCTOU race between two directors starting at the same
 *  instant — only one process's exclusive create can win; the loser falls back to
 *  reading what the winner wrote and reports it as foreign. Refreshing our own
 *  existing lock still uses a plain write since we already own it. */
/** `force`: explicit override to reclaim a lock reported UNKNOWN (foreign host) —
 *  never applied automatically. Without it, a foreign-host lock blocks exactly like a
 *  live one; it just gets a distinguishable reason so the caller doesn't tell the
 *  operator "another director is running" when it might just be a stale lock from a
 *  machine that isn't this one. */
export function acquireOrCheckLock(force = false): LockInfo | null {
	const existing = readLock();
	if (existing && existing.pid !== process.pid) {
		const liveness = lockLiveness(existing);
		if (liveness === "alive") return existing; // foreign + alive → caller must not proceed
		if (liveness === "unknown-foreign-host" && !force) return existing; // ambiguous → block until explicit override
	}
	const info: LockInfo = {
		pid: process.pid,
		host: os.hostname(),
		startedAt: existing && existing.pid === process.pid ? existing.startedAt : new Date().toISOString(),
	};
	if (!existing) {
		// No lock file observed — try to win it atomically via exclusive create.
		fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
		try {
			const fd = fs.openSync(lockPath(), "wx");
			fs.writeSync(fd, JSON.stringify(info, null, 2));
			fs.closeSync(fd);
			return null; // we won the race
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST") {
				// Someone else won the race between our read and our create attempt.
				const winner = readLock();
				if (winner && winner.pid !== process.pid && isPidAlive(winner.pid)) return winner;
				// Winner turned out to be us, dead, or unreadable — fall through to reclaim below.
			} else {
				throw e;
			}
		}
	}
	writeJson(lockPath(), info);
	return null;
}
