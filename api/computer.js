/**
 * api/computer.js — Computer Mode
 *
 * Orchestrates a team of AI specialists + optional Windows desktop control.
 *
 * Flow:
 *  1. Coordinator (kimi-k2.6) decomposes the task into subtasks
 *  2. Specialist models run subtasks in parallel (DeepSeek, GLM, Qwen, MiniMax)
 *  3. If task needs a real desktop, the coordinator uses Windows tools
 *  4. Coordinator synthesizes all results into a final answer
 *
 * SSE events:
 *  phase        { phase, message }
 *  plan         { subtasks: [{id, task, model}] }
 *  specialist_start { taskId, model }
 *  specialist_done  { taskId, model, result, error? }
 *  windows_action   { action, args, screenshot? }
 *  thinking     { text }
 *  reply        { text }
 *  error        { text }
 *  done         {}
 */

import https from "node:https";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { ghRead, ghWrite } from "../src/sync/github-storage.mjs";
import { nextApiKey as nextNimKey } from "../src/storage/keypool.mjs";
import {
  recall as memoryRecall,
  saveFact as memorySaveFact,
  recordTurn as memoryRecordTurn,
  distillFacts as memoryDistill,
} from "../src/memory/cloud-memory.mjs";
import { openHeliosSession, isHeliosTool, execHeliosTool, HELIOS_TOOLS } from "../src/tools/helios-integration.mjs";

// ── Config ────────────────────────────────────────────────────────────────────

const NIM_BASE = "https://integrate.api.nvidia.com/v1";
const CALL_TIMEOUT = 180_000;         // 3 min per coordinator/synthesis call
const SPECIALIST_TIMEOUT = 60_000;    // 1 min per specialist — fail fast on broken/slow models

const COORDINATOR = {
  name: "Llama 3.3 70B",
  model: process.env.MODEL ?? "meta/llama-3.3-70b-instruct",
  apiKey: process.env.NVIDIA_API_KEY ?? "",
  baseUrl: NIM_BASE,
};

// Specialists keep their dedicated keys (rate-limit isolation) but the model
// behind each slot is chosen for *availability* on NIM right now. Verified
// 2026-05-14 via /diag?ping=. If a model goes down again, swap the model
// string here and redeploy — the key wiring remains stable.
const SPECIALISTS = [
  { id: 1, name: "Llama-3.3 (DS slot)", model: "meta/llama-3.3-70b-instruct", apiKey: process.env.NVIDIA_KEY_DEEPSEEK ?? "", role: "Deep reasoning, math, and code analysis" },
  { id: 2, name: "GLM-5.1",             model: "z-ai/glm-5.1",                apiKey: process.env.NVIDIA_KEY_GLM     ?? "", role: "Structured thinking and language tasks" },
  { id: 3, name: "Qwen 3.5-397B",       model: "qwen/qwen3.5-397b-a17b",      apiKey: process.env.NVIDIA_KEY_QWEN    ?? "", role: "Factual research and broad knowledge" },
  { id: 4, name: "Llama-3.1 (MM slot)", model: "meta/llama-3.1-70b-instruct", apiKey: process.env.NVIDIA_KEY_MINIMAX ?? "", role: "Creative synthesis and diverse perspectives" },
];

const BRIDGE_URL   = process.env.WINDOWS_BRIDGE_URL   ?? "";
const BRIDGE_TOKEN = process.env.WINDOWS_BRIDGE_TOKEN ?? "";
const WIN_ENABLED  = !!BRIDGE_URL;
const MAX_COORDINATOR_ROUNDS = parseInt(process.env.COMPUTER_MAX_ROUNDS ?? "10", 10);

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const keepAlive = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000 });

// Raw call — returns the full message object (so callers can inspect tool_calls).
function nimCallRaw(model, apiKey, messages, { maxTokens = 4096, tools = null, timeoutMs = CALL_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const payload = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
      top_p: 0.95,
      stream: false,
      chat_template_kwargs: { thinking: false },
    };
    if (tools && tools.length) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }
    const body = JSON.stringify(payload);

    const timer = setTimeout(() => { req.destroy(); reject(new Error(`LLM timeout (${timeoutMs}ms): ${model}`)); }, timeoutMs);
    let settled = false;
    const done = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };

    const req = https.request(
      {
        hostname: "integrate.api.nvidia.com",
        path: "/v1/chat/completions",
        method: "POST",
        agent: keepAlive,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => done(() => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            else resolve(parsed?.choices?.[0]?.message ?? { content: "" });
          } catch { resolve({ content: raw.slice(0, 200) }); }
        }));
        res.on("error", (e) => done(() => reject(e)));
      }
    );
    req.on("error", (e) => done(() => reject(e)));
    req.write(body); req.end();
  });
}

// Convenience: just the content string (used by specialists + synthesis).
function nimCall(model, apiKey, messages, maxTokens = 4096, timeoutMs = CALL_TIMEOUT) {
  return nimCallRaw(model, apiKey, messages, { maxTokens, timeoutMs }).then(m => m?.content ?? "");
}

// Retry wrapper for content-only calls
async function nimCallRetry(model, apiKey, messages, maxTokens = 4096, retries = 2, timeoutMs = CALL_TIMEOUT) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await nimCall(model, apiKey, messages, maxTokens, timeoutMs); }
    catch (e) { last = e; if (i < retries) await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
  throw last;
}

// Retry wrapper for tool-enabled calls
async function nimCallToolsRetry(model, apiKey, messages, tools, maxTokens = 4096, retries = 2) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await nimCallRaw(model, apiKey, messages, { maxTokens, tools }); }
    catch (e) { last = e; if (i < retries) await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
  throw last;
}

// ── Windows bridge helper ─────────────────────────────────────────────────────

function bridgeCall(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    if (!BRIDGE_URL) return reject(new Error("Windows bridge not configured"));
    const url = new URL(path, BRIDGE_URL.endsWith("/") ? BRIDGE_URL : BRIDGE_URL + "/");
    const payload = body ? JSON.stringify(body) : null;
    const lib = url.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Token": BRIDGE_TOKEN,
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); } });
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Bridge timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Windows tools for the coordinator agent ───────────────────────────────────

const WIN_TOOLS = WIN_ENABLED ? [
  {
    type: "function",
    function: {
      name: "win_screenshot",
      description: "Take a screenshot of the Windows desktop and see what's on screen.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "win_click",
      description: "Click at pixel coordinates on the Windows desktop.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", description: "X coordinate" },
          y: { type: "integer", description: "Y coordinate" },
          button: { type: "string", enum: ["left", "right", "middle"] },
          double: { type: "boolean", description: "Double click" },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "win_type",
      description: "Type text on the Windows desktop (at the current focus).",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "win_key",
      description: "Press a keyboard key (e.g. enter, escape, tab, f5).",
      parameters: {
        type: "object",
        properties: { key: { type: "string" }, presses: { type: "integer" } },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "win_hotkey",
      description: "Press a keyboard shortcut (e.g. ctrl+c, win+d, alt+f4).",
      parameters: {
        type: "object",
        properties: { keys: { type: "array", items: { type: "string" }, description: "e.g. ['ctrl','c']" } },
        required: ["keys"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "win_open",
      description: "Launch a Windows application (e.g. notepad, chrome, cmd, powershell).",
      parameters: {
        type: "object",
        properties: { app: { type: "string" } },
        required: ["app"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "win_run",
      description: "Run a Windows shell command (CMD). Returns stdout/stderr.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, timeout_ms: { type: "integer" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "win_powershell",
      description: "Run a PowerShell script on Windows. Returns stdout/stderr.",
      parameters: {
        type: "object",
        properties: { script: { type: "string" }, timeout_ms: { type: "integer" } },
        required: ["script"],
      },
    },
  },
] : [];

async function execWinTool(name, args) {
  try {
    switch (name) {
      case "win_screenshot": {
        const r = await bridgeCall("/screenshot", "GET");
        return { ok: true, screenshot: r.screenshot, width: r.width, height: r.height };
      }
      case "win_click":      return bridgeCall("/click", "POST", args);
      case "win_type":       return bridgeCall("/type", "POST", args);
      case "win_key":        return bridgeCall("/key", "POST", args);
      case "win_hotkey":     return bridgeCall("/hotkey", "POST", args);
      case "win_open":       return bridgeCall("/open", "POST", args);
      case "win_run":        return bridgeCall("/run", "POST", args);
      case "win_powershell": return bridgeCall("/powershell", "POST", args);
      default: return { error: `Unknown Windows tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// ── Linux shell + memory tools for the coordinator (always available) ────────

// All Linux/coding tools come from HELIOS (shell, read_file, write_file,
// grep, glob, apply_patch, code_task, web_search, web_fetch). Each routes
// to the session's E2B sandbox where codex + openclaude are preinstalled.
const LINUX_TOOLS = HELIOS_TOOLS;

const MEMORY_TOOLS = [
  {
    type: "function",
    function: {
      name: "memory_recall",
      description:
        "Search the persistent cross-session memory + the markdown/html vault " +
        "(solis-agent-files/memory and vault). Returns ranked snippets relevant to the query. " +
        "Use this when prior conversations or stored notes might be useful.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          k:     { type: "integer", description: "Max snippets (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_save",
      description:
        "Persist a single durable fact to cross-session memory. Use for user identity, " +
        "preferences, project facts, choices, and constraints that will help future runs.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "One concise sentence" },
          scope: { type: "string", enum: ["session", "global"] },
        },
        required: ["fact"],
      },
    },
  },
];

async function execMemoryTool(name, args, ctx = {}) {
  try {
    if (name === "memory_recall") {
      const k = Math.min(args.k ?? 5, 10);
      const hits = await memoryRecall(args.query ?? "", { k });
      return { query: args.query, hits };
    }
    if (name === "memory_save") {
      const scope = args.scope === "session" ? (ctx.sessionId || "_global") : "_global";
      return await memorySaveFact(args.fact ?? "", { sessionId: scope, source: "computer-mode" });
    }
    return { error: `Unknown memory tool: ${name}` };
  } catch (e) { return { error: e.message }; }
}

const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map(t => t.function.name));

async function execLinuxTool(name, args, ctx = {}) {
  if (!isHeliosTool(name)) return { error: `Unknown Linux tool: ${name}` };
  if (!ctx.heliosSession)  return { error: "helios session not initialized" };
  return await execHeliosTool(ctx.heliosSession, name, args);
}

const LINUX_TOOL_NAMES = new Set(LINUX_TOOLS.map(t => t.function.name));
const WIN_TOOL_NAMES   = new Set(WIN_TOOLS.map(t => t.function.name));

// ── Planning prompt ───────────────────────────────────────────────────────────

function buildCoordinatorSystemPrompt() {
  const winSection = WIN_ENABLED
    ? `\n## Windows Desktop Tools\nYou have full control of a live Windows 10 desktop. Use win_screenshot first to see the current state, then use the mouse/keyboard/shell tools to accomplish tasks.\n`
    : "\n## Windows Desktop\nNot configured (set WINDOWS_BRIDGE_URL to enable).\n";

  return `You are Solis in Computer Mode — an AI coordinator managing a team of specialist AI models with direct OS access via the HELIOS coding-agent harness.

## Your Role
- Analyze the user's request
- Use the HELIOS sandbox for any real Linux/coding work
- Delegate pure research/analysis subtasks to specialists
- Use Windows desktop tools when the task requires real desktop interaction
- Synthesize all results into a comprehensive final answer

## Execution environment (HELIOS — always available)
A sticky Ubuntu sandbox (E2B) with codex + openclaude pre-installed runs
your shell, file, and coding tools. Files survive across turns within the
session. HELIOS routes each call to the strongest backend.

- **shell** — bash in the Ubuntu sandbox (apt, full Linux, persistent FS)
- **read_file**, **write_file** — sandbox filesystem I/O
- **grep**, **glob** — ripgrep search and filesystem glob
- **apply_patch** — apply a unified diff (codex apply-patch)
- **code_task** — delegate a multi-step coding task to a sub-agent (codex or openclaude)
- **web_search**, **web_fetch** — research the web
- Prefer real commands over speculation.

## Persistent Memory (always available)
You have a cross-session memory backed by the solis-agent-files GitHub repo.
- The most relevant snippets are auto-injected as <PRIOR_CONTEXT> at the start.
- memory_recall(query): pull more snippets when you need to dig deeper.
- memory_save(fact, scope): persist a durable fact (user identity, project facts,
  preferences, decisions). Always save anything that will help future runs.
${winSection}
## Specialist Team
${SPECIALISTS.map(s => `- **${s.name}**: ${s.role}`).join("\n")}

## Rules
- For factual or computational work, always reach for shell_exec instead of guessing.
- For desktop work, always win_screenshot first before clicking — confirm coordinates.
- Show your work. Call tools step by step rather than batching speculation.
- Be thorough but concise.`;
}

// ── Vercel handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { message, sessionId, userApiKey, userProvider } = req.body ?? {};
  if (!message?.trim()) return res.status(400).json({ error: "missing message" });

  // Pick a coordinator key in priority order:
  //   1. user-supplied key from the UI's API Configuration panel
  //   2. NVIDIA_API_KEY env var
  //   3. any NVIDIA NIM key from the pool (NVIDIA_KEY_DEEPSEEK / _GLM / …)
  // Any NIM-issued key can call any NIM-hosted model, so the specialist keys
  // also work as a coordinator key fallback.
  const poolKey = await nextNimKey().catch(() => "");
  const coordinatorKey = (userApiKey?.trim()) || COORDINATOR.apiKey || poolKey;
  if (!coordinatorKey) {
    return res.status(400).json({
      error:
        "No NVIDIA NIM key available. Set NVIDIA_API_KEY (or any NVIDIA_KEY_*) " +
        "in the Vercel project env, or paste a key into the API Configuration " +
        "panel on the home page.",
    });
  }

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // ── Dual-track: SSE + GitHub-persisted job record (page-leave survival) ────
  const jobId = randomUUID();
  const createdAt = Date.now();
  const jobPath = `sessions/jobs/${jobId}.json`;
  const jobBase = {
    id: jobId,
    mode: "computer",
    status: "running",
    message: message.trim(),
    sessionId: sessionId ?? null,
    provider: "Computer Mode",
    model: COORDINATOR.model,
    created: createdAt,
    updated: createdAt,
    phase: "initializing",
    plan: [],
    specialists: {},
    toolActions: [],
    reply: null,
    error: null,
    durationMs: null,
    rounds: [],
  };

  // Cancel-on-demand: if any function instance flips cancelRequested on the
  // job record (via POST /job?action=cancel), our next read picks it up and
  // the coordinator/synthesis loop exits cleanly with status="cancelled".
  let cancelled = false;
  const isCancelled = () => cancelled;
  const CANCEL = () => { const e = new Error("Cancelled by user"); e.code = "CANCELLED"; throw e; };

  async function ghSafeWrite(content) {
    try {
      const ex = await ghRead(jobPath);
      if (ex?.content) {
        try { if (JSON.parse(ex.content).cancelRequested) cancelled = true; } catch {}
      }
      await ghWrite(jobPath, content, ex?.sha ?? null);
    } catch {
      try {
        const fresh = await ghRead(jobPath);
        if (fresh?.content) {
          try { if (JSON.parse(fresh.content).cancelRequested) cancelled = true; } catch {}
        }
        await ghWrite(jobPath, content, fresh?.sha ?? null);
      } catch {}
    }
  }
  let writeChain = ghSafeWrite(JSON.stringify(jobBase, null, 2));
  const persist = () => {
    const snap = { ...jobBase, updated: Date.now() };
    writeChain = writeChain.then(() => ghSafeWrite(JSON.stringify(snap, null, 2))).catch(() => {});
  };

  const sseWrite = (type, data = {}) => {
    try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
  };
  sseWrite("job", { jobId });

  // SSE keep-alive comment every 15s so intermediaries and the browser don't
  // drop the stream during long-running LLM calls.
  const keepAlive = setInterval(() => {
    try { res.write(`: keep-alive ${Date.now()}\n\n`); } catch {}
  }, 15000);

  const send = (type, data = {}) => {
    sseWrite(type, data);
    // Also mirror relevant events into the persisted job record
    switch (type) {
      case "phase":
        jobBase.phase = data.phase ?? data.message ?? jobBase.phase;
        persist();
        break;
      case "plan":
        jobBase.plan = data.subtasks ?? [];
        persist();
        break;
      case "specialist_start":
        jobBase.specialists[data.taskId] = { model: data.model, status: "running" };
        persist();
        break;
      case "specialist_done":
        jobBase.specialists[data.taskId] = {
          ...(jobBase.specialists[data.taskId] || {}),
          model: data.model,
          status: data.error ? "error" : "done",
          result: data.result,
        };
        persist();
        break;
      case "tool_action":
        jobBase.toolActions.push({
          kind: data.kind, action: data.action,
          args: data.args, result: data.result,
          at: Date.now(),
        });
        persist();
        break;
      case "exec_visual":
        // Rich live-execution feed for the Exec Viewer panel. Merge start
        // + end events by execId so the persisted record stays compact.
        if (!jobBase.execVisuals) jobBase.execVisuals = [];
        if (data.phase === "start") {
          jobBase.execVisuals.push({
            execId: data.execId, tool: data.tool, kind: data.kind,
            backend: data.backend, code: data.code, path: data.path,
            startedAt: data.startedAt, status: "running",
          });
        } else if (data.phase === "end") {
          const ev = jobBase.execVisuals.find((e) => e.execId === data.execId);
          const patch = {
            stdout: data.stdout, stderr: data.stderr, reply: data.reply,
            files: data.files, exit_code: data.exit_code, error: data.error,
            endedAt: data.endedAt,
            status: data.error || data.exit_code !== 0 ? "failed" : "done",
          };
          if (ev) Object.assign(ev, patch);
          else jobBase.execVisuals.push({ execId: data.execId, tool: data.tool, ...patch });
        }
        persist();
        break;
      case "reply":
        jobBase.reply = data.text;
        jobBase.status = "done";
        jobBase.phase = "done";
        jobBase.durationMs = Date.now() - createdAt;
        persist();
        break;
      case "error":
        jobBase.error = data.text;
        jobBase.status = "error";
        jobBase.durationMs = Date.now() - createdAt;
        persist();
        break;
    }
  };

  // Keep running after client disconnects (Vercel honours event loop up to maxDuration).
  req.on?.("close", () => { /* no-op */ });

  let heliosOpen = null;
  try {
    // ── Phase 1: Planning ────────────────────────────────────────────────────
    send("phase", { phase: "planning", message: "Coordinator analyzing task…" });
    if (isCancelled()) CANCEL();

    const availableSpecialists = SPECIALISTS.filter(s => s.apiKey);
    const numSubtasks = Math.min(availableSpecialists.length, 4);

    const planRaw = await nimCallRetry(
      COORDINATOR.model,
      coordinatorKey,
      [
        {
          role: "system",
          content: `You are a task coordinator. Break the user's request into exactly ${numSubtasks} specific, independent subtasks for parallel specialist processing.

Return ONLY a valid JSON array (no markdown, no explanation):
[
  {"id": 1, "task": "Specific focused subtask description"},
  {"id": 2, "task": "Another focused subtask"},
  ...
]

The subtasks should cover different angles of the problem and be self-contained.`,
        },
        { role: "user", content: message.trim() },
      ],
      1024
    );

    let subtasks = [];
    try {
      const m = planRaw.match(/\[[\s\S]*\]/);
      subtasks = JSON.parse(m ? m[0] : planRaw);
      if (!Array.isArray(subtasks)) throw new Error("not array");
    } catch {
      subtasks = [{ id: 1, task: message.trim() }];
    }

    const assignments = subtasks.slice(0, availableSpecialists.length).map((st, i) => ({
      ...st,
      specialist: availableSpecialists[i % availableSpecialists.length],
    }));

    send("plan", {
      subtasks: assignments.map(a => ({ id: a.id, task: a.task, model: a.specialist.name })),
      windowsEnabled: WIN_ENABLED,
    });

    // ── Phase 2: Specialist parallel execution ───────────────────────────────
    if (isCancelled()) CANCEL();
    send("phase", { phase: "running", message: `${assignments.length} specialists working in parallel…` });

    const specialistResults = await Promise.all(
      assignments.map(async (a) => {
        send("specialist_start", { taskId: a.id, model: a.specialist.name });
        try {
          const result = await nimCallRetry(
            a.specialist.model,
            a.specialist.apiKey,
            [
              {
                role: "system",
                content: `You are a specialist AI (${a.specialist.name}). Your role: ${a.specialist.role}.
You have been assigned a specific subtask as part of a larger collaborative effort. Answer thoroughly and precisely. Your answer will be combined with other specialists' work.`,
              },
              {
                role: "user",
                content: `ORIGINAL QUESTION: ${message.trim()}\n\nYOUR SUBTASK: ${a.task}\n\nProvide a detailed, focused answer for your specific subtask.`,
              },
            ],
            4096,
            1,                      // retries = 1 (cap total wait)
            SPECIALIST_TIMEOUT      // 60s per attempt — fail fast on broken models
          );
          send("specialist_done", { taskId: a.id, model: a.specialist.name, result: result.slice(0, 800) });
          return { ...a, result, ok: true };
        } catch (e) {
          send("specialist_done", { taskId: a.id, model: a.specialist.name, result: `Error: ${e.message}`, error: true });
          return { ...a, result: `Failed: ${e.message}`, ok: false };
        }
      })
    );

    // ── Phase 3: Coordinator tool loop (Linux shell + memory + optional Win) ─
    // Always run this so the coordinator has shell + memory access regardless
    // of WIN_ENABLED.
    if (isCancelled()) CANCEL();
    send("phase", { phase: "executing", message: "Coordinator executing tools…" });

    const activeTools = [
      ...LINUX_TOOLS,
      ...MEMORY_TOOLS,
      ...(WIN_ENABLED ? WIN_TOOLS : []),
    ];

    // Auto-inject relevant memory snippets at the top of the coordinator's
    // context. Same pattern as /chat and /submit so behaviour stays consistent.
    let memoryBlock = "";
    try {
      const hits = await memoryRecall(message.trim(), { k: 4 });
      if (hits.length) {
        memoryBlock =
          `\n\n<PRIOR_CONTEXT note="Top relevant snippets from your persistent memory. Trust them as background, verify before acting on them.">\n` +
          hits.map((h, i) => `[#${i + 1} ${h.path}]\n${h.snippet}`).join("\n\n") +
          `\n</PRIOR_CONTEXT>`;
        send("memory_hits", { count: hits.length, paths: hits.map(h => h.path) });
      }
    } catch {}

    // Open a HELIOS session for the duration of this computer-mode run.
    // The same sandbox handles every Linux tool call from the coordinator,
    // so files written by an early `shell` call survive for later steps.
    heliosOpen = await openHeliosSession(sessionId ?? `cm_${jobId}`, {
      baseUrl: COORDINATOR.baseUrl,
      apiKey:  coordinatorKey,
      model:   COORDINATOR.model,
    }).catch(() => null);
    const coordinatorCtx = { sessionId: sessionId ?? null, heliosSession: heliosOpen?.session ?? null };

    const toolMessages = [
      { role: "system", content: buildCoordinatorSystemPrompt() + memoryBlock },
      {
        role: "user",
        content:
          `USER TASK: ${message.trim()}\n\n` +
          `SPECIALIST CONTEXT (treat as advisory, not ground truth):\n` +
          specialistResults.map(r => `[${r.specialist.name}]: ${r.result.slice(0, 400)}`).join("\n\n") +
          `\n\nUse shell_exec for real work (data fetches, computation, file ops). ` +
          `Use memory_recall to pull more prior context, and memory_save for any durable fact you learn. ` +
          (WIN_ENABLED ? `Use win_* tools when the task requires desktop interaction. ` : ``) +
          `When done, reply with a plain text summary of what you actually did and learned.`,
      },
    ];

    let executionSummary = "";
    let round = 0;

    while (round < MAX_COORDINATOR_ROUNDS) {
      if (isCancelled()) CANCEL();
      round++;
      send("round", { round });
      if (isCancelled()) CANCEL();

      const msg = await nimCallToolsRetry(
        COORDINATOR.model,
        coordinatorKey,
        toolMessages,
        activeTools,
        4096,
      ).catch(e => ({ content: `[coordinator error: ${e.message}]` }));

      const toolCalls = msg?.tool_calls;
      const textOut   = msg?.content ?? "";

      if (!toolCalls || toolCalls.length === 0) {
        // No more tools — coordinator is done with the execution phase.
        executionSummary = textOut;
        toolMessages.push({ role: "assistant", content: textOut });
        break;
      }

      // Persist the assistant turn (must include tool_calls so subsequent
      // tool messages have a referent).
      toolMessages.push({ role: "assistant", content: textOut || "", tool_calls: toolCalls });

      for (const tc of toolCalls) {
        const fnName = tc.function?.name;
        let fnArgs = {};
        try { fnArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}

        const kind = LINUX_TOOL_NAMES.has(fnName)  ? "linux"
                   : WIN_TOOL_NAMES.has(fnName)    ? "windows"
                   : MEMORY_TOOL_NAMES.has(fnName) ? "memory"
                   : "unknown";

        const argPreview =
          fnArgs.command ?? fnArgs.script ?? fnArgs.app ?? fnArgs.text ??
          fnArgs.query ?? fnArgs.fact ??
          fnArgs.key ?? (fnArgs.keys && fnArgs.keys.join("+")) ??
          (fnArgs.x !== undefined ? `${fnArgs.x},${fnArgs.y}` : "") ?? "";

        // Emit before execution so the UI shows the command immediately.
        send("tool_action", {
          kind, action: fnName,
          args: String(argPreview).slice(0, 300),
          result: "",
          pending: true,
        });

        // exec_visual — richer event for the Exec Viewer panel. Carries the
        // *full* code body, the backend label, and (in the post-exec emit)
        // the full stdout/stderr + any file edits. This is what the user
        // actually wants to see when watching the agent work.
        const execId = randomUUID();
        const codeBody =
          fnArgs.command ??
          fnArgs.script  ??
          fnArgs.task    ??
          fnArgs.patch   ??
          fnArgs.content ??
          fnArgs.query   ??
          fnArgs.url     ??
          "";
        const backendLabel =
          kind === "windows"             ? "windows-bridge"
          : kind === "memory"            ? "solis-memory"
          : fnName === "apply_patch"     ? "codex"
          : fnName === "code_task"       ? (fnArgs.backend === "codex" ? "codex" : "openclaude")
          : (fnName === "web_search" || fnName === "web_fetch") ? "openclaude"
          : "shell";
        send("exec_visual", {
          phase: "start",
          execId, tool: fnName, kind, backend: backendLabel,
          code: String(codeBody),
          path: fnArgs.path ?? null,
          startedAt: Date.now(),
        });

        let result;
        if (kind === "linux")        result = await execLinuxTool(fnName, fnArgs, coordinatorCtx);
        else if (kind === "windows") result = await execWinTool(fnName, fnArgs);
        else if (kind === "memory")  result = await execMemoryTool(fnName, fnArgs, coordinatorCtx);
        else                         result = { error: `Unknown tool: ${fnName}` };

        // Compact result preview for the UI (the LLM gets the full JSON below).
        const preview =
          result?.stdout ??
          result?.error  ??
          (result?.ok ? (result.screenshot ? "[screenshot taken]" : "ok") : null) ??
          JSON.stringify(result);

        send("tool_action", {
          kind, action: fnName,
          args: String(argPreview).slice(0, 300),
          result: String(preview).slice(0, 600),
        });

        send("exec_visual", {
          phase: "end",
          execId, tool: fnName, kind, backend: backendLabel,
          stdout: String(result?.stdout ?? "").slice(0, 32000),
          stderr: String(result?.stderr ?? "").slice(0, 16000),
          reply:  result?.reply  ? String(result.reply).slice(0, 16000)  : null,
          files:  Array.isArray(result?.files) ? result.files.slice(0, 50) : [],
          exit_code: result?.exit_code ?? (result?.error ? 1 : 0),
          error:  result?.error ?? null,
          endedAt: Date.now(),
        });

        // Special-case: emit win_screenshot images to the desktop viewer too.
        if (fnName === "win_screenshot" && result?.screenshot) {
          send("windows_action", { action: "screenshot", args: {}, screenshot: result.screenshot });
        }

        // Strip screenshots out of LLM-bound payload — they balloon context.
        const llmResult = (fnName === "win_screenshot" && result?.screenshot)
          ? { ok: result.ok, width: result.width, height: result.height, screenshot: "[redacted-binary]" }
          : result;

        toolMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: fnName,
          content: JSON.stringify(llmResult).slice(0, 8000),
        });
      }
    }

    const windowsContext = executionSummary;

    // ── Phase 4: Synthesis ───────────────────────────────────────────────────
    if (isCancelled()) CANCEL();
    send("phase", { phase: "synthesizing", message: "Coordinator synthesizing all results…" });

    const specialistContext = specialistResults
      .filter(r => r.ok)
      .map(r => `### ${r.specialist.name} — ${r.task}\n${r.result}`)
      .join("\n\n---\n\n");

    const synthMessages = [
      {
        role: "system",
        content: `You are the synthesis coordinator. Combine the specialist answers and any desktop work into one comprehensive, well-structured final response.
- Integrate all relevant insights
- Remove redundancy
- Answer the original question completely
- Use clear markdown formatting`,
      },
      {
        role: "user",
        content: `ORIGINAL QUESTION: ${message.trim()}

SPECIALIST RESULTS:
${specialistContext}
${windowsContext ? `\nCOORDINATOR EXECUTION (shell + desktop work):\n${windowsContext}` : ""}

Synthesize everything into the best possible final answer.`,
      },
    ];

    const finalAnswer = await nimCallRetry(
      COORDINATOR.model,
      coordinatorKey,
      synthMessages,
      8192
    );

    send("reply", { text: finalAnswer });
    sseWrite("done");

    // ── Persistent memory side-effects (best-effort, non-blocking) ───────────
    if (sessionId) {
      memoryRecordTurn(sessionId, message.trim(), finalAnswer).catch(() => {});
      const llmShim = async (msgs) =>
        await nimCall(COORDINATOR.model, coordinatorKey, msgs, 600).catch(() => "");
      const synthHistory = [
        { role: "user", content: message.trim() },
        { role: "assistant", content: finalAnswer },
      ];
      memoryDistill(sessionId, synthHistory, llmShim).catch(() => {});
    }
  } catch (err) {
    if (err?.code === "CANCELLED") {
      jobBase.status = "cancelled";
      jobBase.cancelledAt = Date.now();
      jobBase.durationMs = Date.now() - createdAt;
      sseWrite("cancelled", { text: "Cancelled by user" });
      persist();
    } else {
      send("error", { text: err.message });
    }
  }

  clearInterval(keepAlive);
  // Flush the final job record to GitHub before letting the function exit.
  await writeChain.catch(() => {});
  await ghSafeWrite(JSON.stringify({ ...jobBase, updated: Date.now() }, null, 2)).catch(() => {});
  try { await heliosOpen?.close(); } catch {}
  try { res.end(); } catch {}
}
