/**
 * helios-integration.mjs — thin bridge between Solis's api/*.js handlers
 * and the standalone @everaldtah/helios harness.
 *
 * Responsibilities:
 *   1. Memoize a single HeliosHarness per process (cheap to construct, but
 *      reuse keeps the e2b SDK module load amortized).
 *   2. Persist the per-session SandboxHandle in Redis (best-effort) so a
 *      cold Vercel function instance can reconnect to the same sandbox.
 *   3. Drain HELIOS event streams into the {stdout, stderr, exit_code, …}
 *      result shape Solis already emits to its UI.
 *
 * This module is the *only* file that should import @everaldtah/helios —
 * api/*.js stay clean.
 */

import { HeliosHarness, collect } from "@everaldtah/helios";
import { redisGet, redisSet } from "../storage/redis.mjs";
import {
  recall as memoryRecall,
  saveFact as memorySaveFact,
} from "../memory/cloud-memory.mjs";

const REDIS_AVAILABLE = !!(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);
const SANDBOX_TTL_SECS = 60 * 60; // 1 hour — long enough to survive a fresh
                                  // browser tab; E2B will reap the sandbox
                                  // before this in most cases.

let _harness = null;
let _harnessCfg = null;

export function getHarness({ baseUrl, apiKey, model }) {
  const sig = `${baseUrl}|${apiKey}|${model}`;
  if (_harness && _harnessCfg === sig) return _harness;

  _harness = new HeliosHarness({
    provider: { baseUrl, apiKey, model },
    e2b: {
      apiKey:   process.env.E2B_API_KEY || "",
      template: process.env.HELIOS_E2B_TEMPLATE || "helios-base",
    },
    memory: { recall: memoryRecall, save: memorySaveFact },
    log: (s) => console.log(`[helios] ${s}`),
  });
  _harnessCfg = sig;
  return _harness;
}

// ── Sandbox-handle persistence (Redis primary, no-op fallback) ───────────────

const handleKey = (sessionId) => `helios-sandbox:${sessionId}`;

async function loadHandle(sessionId) {
  if (!REDIS_AVAILABLE) return undefined;
  try {
    const raw = await redisGet(handleKey(sessionId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    return parsed?.sandboxId ? parsed : undefined;
  } catch (e) {
    console.warn(`[helios] loadHandle ${sessionId}: ${e.message}`);
    return undefined;
  }
}

async function saveHandle(sessionId, handle) {
  if (!REDIS_AVAILABLE || !handle?.sandboxId) return;
  try {
    await redisSet(handleKey(sessionId), JSON.stringify(handle), SANDBOX_TTL_SECS);
  } catch (e) {
    console.warn(`[helios] saveHandle ${sessionId}: ${e.message}`);
  }
}

// ── Session helper used by api/*.js ──────────────────────────────────────────

/**
 * Open a HeliosSession for the duration of one HTTP request. Multiple tool
 * calls in the same request reuse the same session/sandbox. The handle is
 * persisted on close so the next request can reconnect.
 */
export async function openHeliosSession(sessionId, providerCfg) {
  const harness = getHarness(providerCfg);
  const existing = await loadHandle(sessionId);
  const session = await harness.resumeSession(sessionId, existing);
  return {
    session,
    close: async () => {
      try { await saveHandle(sessionId, session.handle()); } catch {}
      // We do NOT call session.close() — the sandbox is sticky.
    },
  };
}

// ── Tool dispatch helpers ────────────────────────────────────────────────────

const HELIOS_TOOL_NAMES = new Set([
  "shell", "read_file", "write_file", "grep", "glob",
  "apply_patch", "code_task", "web_search", "web_fetch",
  // Back-compat aliases — keep working until the next release.
  "shell_exec", "ubuntu_exec", "file_write",
]);

export function isHeliosTool(name) { return HELIOS_TOOL_NAMES.has(name); }

/**
 * Run one tool call on a session and return the Solis-shaped result.
 * Drains the HeliosEvent stream synchronously — Solis's existing UI gets
 * one tool_result event per tool call (which matches the old behavior).
 */
export async function execHeliosTool(session, name, args) {
  const drained = await collect(session.exec(name, args || {}));
  if (drained.result && typeof drained.result === "object") {
    return drained.result;
  }
  return {
    stdout: drained.stdout || undefined,
    stderr: drained.stderr || undefined,
    reply:  drained.reply  || undefined,
    files:  drained.files.length ? drained.files : undefined,
    ok:     drained.ok,
  };
}

/**
 * Tool schema HELIOS contributes to Solis's TOOLS arrays.
 * Solis appends its own vault_*, memory_*, http_get definitions on top.
 */
export const HELIOS_TOOLS = HeliosHarness.tools();
