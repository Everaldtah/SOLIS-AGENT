/**
 * api/submit.js — Background job submission
 *
 * POST { message, sessionId, userApiKey?, userProvider?, userModel? }
 * → 202 { jobId, status: "running" }
 *
 * The response is sent immediately. The agent then continues processing
 * on the server — progress is written to GitHub storage at
 * sessions/jobs/<jobId>.json so the user can poll /job?id=<jobId>
 * after closing the page and retrieve complete results.
 *
 * maxDuration is 300s (same as /chat). Jobs are safe to start and leave.
 */

import https from "node:https";
import { randomUUID } from "node:crypto";
import { ghRead, ghWrite } from "../src/sync/github-storage.mjs";
import { pullSession, pushSession } from "../src/storage/sessions.mjs";
import { nextApiKey } from "../src/storage/keypool.mjs";
import { recall as memoryRecall, saveFact as memorySaveFact, recordTurn as memoryRecordTurn, distillFacts as memoryDistill } from "../src/memory/cloud-memory.mjs";
import { openHeliosSession, isHeliosTool, execHeliosTool, HELIOS_TOOLS } from "../src/tools/helios-integration.mjs";

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_API_KEY  = process.env.NVIDIA_API_KEY    ?? "";
const DEFAULT_BASE_URL = process.env.NVIDIA_BASE_URL   ?? "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL    = process.env.MODEL             ?? "openai/gpt-oss-120b";
const MAX_TOOL_ROUNDS  = parseInt(process.env.MAX_TOOL_ROUNDS   ?? "15", 10);
const HISTORY_MAX_MSGS = parseInt(process.env.HISTORY_MAX_MSGS  ?? "60", 10);
const CALL_TIMEOUT_MS  = parseInt(process.env.NVIDIA_TIMEOUT_MS ?? "250000", 10);

const PROVIDERS = {
  nvidia:     { baseUrl: "https://integrate.api.nvidia.com/v1",  defaultModel: "openai/gpt-oss-120b" },
  openai:     { baseUrl: "https://api.openai.com/v1",            defaultModel: "gpt-4o" },
  groq:       { baseUrl: "https://api.groq.com/openai/v1",       defaultModel: "llama-3.3-70b-versatile" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1",         defaultModel: "openai/gpt-4o" },
  deepseek:   { baseUrl: "https://api.deepseek.com/v1",          defaultModel: "deepseek-chat" },
  xai:        { baseUrl: "https://api.x.ai/v1",                  defaultModel: "grok-2" },
  mistral:    { baseUrl: "https://api.mistral.ai/v1",            defaultModel: "mistral-large-latest" },
  together:   { baseUrl: "https://api.together.xyz/v1",          defaultModel: "meta-llama/Llama-3-70b-chat-hf" },
};

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(model, providerName) {
  return `You are Solis, an advanced AI agent powered by the HELIOS coding-agent harness.
You are powered by ${model} via ${providerName}.

## Identity
- Name: Solis
- Interface: Background-job mode (responses persist to GitHub; the user may close the page)
- Storage: GitHub repo — vault and sessions synced

## Execution environment (HELIOS)
All shell, file, code, and web tools run inside a sticky Ubuntu sandbox
provisioned by HELIOS (E2B Linux). The sandbox persists across turns within
the same session — files you write survive until the sandbox is idle-reaped.
Codex and OpenClaude are pre-installed inside the sandbox; HELIOS routes
each tool call to whichever backend is strongest at it.

## Your tools (HELIOS)
- **shell** — bash in the Ubuntu sandbox (apt, full Linux, persistent FS)
- **read_file**, **write_file** — sandbox filesystem I/O
- **grep**, **glob** — ripgrep-backed search and filesystem glob
- **apply_patch** — apply a unified diff (codex-style apply-patch)
- **code_task** — delegate a multi-step coding task to a sub-agent (codex or openclaude)
- **web_search**, **web_fetch** — research the web

## Your tools (Solis-owned)
- **vault_read / vault_write / vault_list / vault_search** — GitHub memory vault
- **memory_recall** — search persistent cross-session memory + vault
- **memory_save** — save a durable fact (survives across sessions)
- **http_get** — simple HTTP GET

## Persistent memory
Cross-session memory lives in solis-agent-files/memory/. Relevant snippets are
auto-injected as <PRIOR_CONTEXT>. Use memory_save for anything durable.

## Rules
- Always use tools for real work. Never fake or simulate output.
- Prefer **shell** for one-shot commands; **code_task** for multi-step coding work.
- After running commands, store useful results in the vault for future sessions.
- Be concise but thorough. Use markdown.`;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const TOOLS = [
  // HELIOS-provided tools (shell, file ops, code_task, web_*) routed to E2B.
  ...HELIOS_TOOLS,
  {
    type: "function",
    function: {
      name: "vault_read",
      description: "Read a note from the GitHub memory vault.",
      parameters: {
        type: "object",
        properties: { note_path: { type: "string" } },
        required: ["note_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_write",
      description: "Write a note to the GitHub memory vault (persists across sessions).",
      parameters: {
        type: "object",
        properties: { note_path: { type: "string" }, content: { type: "string" } },
        required: ["note_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_list",
      description: "List notes in the vault.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_search",
      description: "Full-text search across vault notes.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_get",
      description: "HTTP GET request. Returns status + body.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_recall",
      description: "Search persistent cross-session memory + the markdown/html vault for snippets relevant to a query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          k: { type: "integer" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_save",
      description: "Save a durable fact to persistent memory. Use for user identity, preferences, project facts.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string" },
          scope: { type: "string", enum: ["session", "global"] },
        },
        required: ["fact"],
      },
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

const vaultCache = new Map();

async function execTool(name, args, ctx = {}) {
  try {
    // HELIOS-owned tools route to the session's E2B sandbox.
    if (isHeliosTool(name)) {
      if (!ctx.heliosSession) return { error: "helios session not initialized" };
      return await execHeliosTool(ctx.heliosSession, name, args);
    }

    switch (name) {
      case "vault_read": {
        const rp = `vault/${args.note_path}`;
        if (vaultCache.has(rp)) return { content: vaultCache.get(rp) };
        const r = await ghRead(rp);
        if (!r) return { error: `Not found: ${args.note_path}` };
        vaultCache.set(rp, r.content);
        return { content: r.content.slice(0, 10000) };
      }
      case "vault_write": {
        const rp = `vault/${args.note_path}`;
        const ex = await ghRead(rp);
        await ghWrite(rp, args.content, ex?.sha ?? null);
        vaultCache.set(rp, args.content);
        return { success: true, note_path: args.note_path };
      }
      case "vault_list": {
        const { ghList } = await import("../src/sync/github-storage.mjs");
        const prefix = args.path ? `vault/${args.path}` : "vault";
        const entries = await ghList(prefix);
        return { entries: entries.map(e => e.type === "dir" ? e.name + "/" : e.name) };
      }
      case "vault_search": {
        const q = args.query.toLowerCase();
        const results = [];
        async function search(dir) {
          const { ghList } = await import("../src/sync/github-storage.mjs");
          for (const e of await ghList(dir)) {
            if (e.type === "dir") await search(e.path);
            else if (e.name.endsWith(".md")) {
              const f = await ghRead(e.path);
              if (f?.content.toLowerCase().includes(q)) {
                const lines = f.content.split("\n").filter(l => l.toLowerCase().includes(q));
                results.push({ note: e.path.replace(/^vault\//, ""), matches: lines.slice(0, 3) });
              }
            }
          }
        }
        await search("vault");
        return { query: args.query, results };
      }
      case "http_get": {
        return await new Promise(res =>
          https.get(args.url, { timeout: 15000 }, r => {
            let body = "";
            r.on("data", c => body += c);
            r.on("end", () => res({ status: r.statusCode, body: body.slice(0, 8000) }));
          }).on("error", e => res({ error: e.message }))
        );
      }
      case "memory_recall": {
        const k = Math.min(args.k ?? 5, 10);
        const hits = await memoryRecall(args.query ?? "", { k });
        return { query: args.query, hits };
      }
      case "memory_save": {
        const scope = args.scope === "session" ? (ctx.sessionId || "_global") : "_global";
        const r = await memorySaveFact(args.fact ?? "", { sessionId: scope, source: "agent" });
        return r;
      }
      default: return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const keepAlive = new https.Agent({ keepAlive: true, keepAliveMsecs: 20_000 });

function llmPost(baseUrl, apiKey, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(`${baseUrl}/chat/completions`);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      req.destroy(); reject(new Error(`LLM timeout after ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST", agent: keepAlive,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        Authorization: `Bearer ${apiKey}`,
      },
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        if (settled) return; settled = true; clearTimeout(timer);
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
      res.on("error", e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    });
    req.on("error", e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    req.write(data); req.end();
  });
}

async function llmPostRetry(baseUrl, apiKey, body, retries = 2) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await llmPost(baseUrl, apiKey, body); }
    catch (err) {
      last = err;
      if (i < retries) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

// ── Agentic loop ──────────────────────────────────────────────────────────────

async function runAgent(userText, history, onEvent, providerCfg = {}, ctx = {}, isCancelled = () => false) {
  const {
    apiKey  = DEFAULT_API_KEY,
    baseUrl = DEFAULT_BASE_URL,
    model   = DEFAULT_MODEL,
    provider = "NVIDIA NIM",
  } = providerCfg;

  let systemPrompt = buildSystemPrompt(model, provider);

  // Auto-inject relevant memory snippets before the run starts.
  try {
    const hits = await memoryRecall(userText, { k: 4 });
    if (hits.length) {
      const block = hits.map((h, i) => `[#${i + 1} ${h.path}]\n${h.snippet}`).join("\n\n");
      systemPrompt += `\n\n<PRIOR_CONTEXT note="Top relevant snippets from your persistent memory. Trust them as background, verify before acting on them.">\n${block}\n</PRIOR_CONTEXT>`;
      onEvent("memory_hits", { count: hits.length, paths: hits.map(h => h.path) });
    }
  } catch {}

  history.push({ role: "user", content: userText });
  const getMessages = () => [{ role: "system", content: systemPrompt }, ...history.slice(-HISTORY_MAX_MSGS)];
  const isNvidia = baseUrl.includes("nvidia") || baseUrl.includes("integrate.api");

  let round = 0;
  let finalContent = null;

  while (round < MAX_TOOL_ROUNDS) {
    if (isCancelled()) throw new CancelledError();
    round++;
    onEvent("round", { round });
    if (isCancelled()) throw new CancelledError();

    const reqBody = {
      model,
      messages: getMessages(),
      max_tokens: 16384,
      temperature: 1.0,
      top_p: 1.0,
      stream: false,
      tools: TOOLS,
      tool_choice: "auto",
      ...(isNvidia ? { chat_template_kwargs: { thinking: true } } : {}),
    };

    const res = await llmPostRetry(baseUrl, apiKey, reqBody);
    if (res?.error) throw new Error(res.error.message || JSON.stringify(res.error));
    const choice = res?.choices?.[0];
    if (!choice) throw new Error("Empty response from provider");

    const msg = choice.message;
    const toolCalls = msg?.tool_calls;
    const thinking = msg?.reasoning_content ?? msg?.reasoning ?? "";

    if (thinking) {
      onEvent("thinking", { text: thinking.slice(0, 600) + (thinking.length > 600 ? "…" : "") });
    }

    if (!toolCalls || toolCalls.length === 0) {
      finalContent = msg?.content || thinking || "";
      history.push({ role: "assistant", content: finalContent });
      break;
    }

    history.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const fnName = tc.function?.name;
      let fnArgs = {};
      try { fnArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      const keyArg = fnArgs.command || fnArgs.note_path || fnArgs.path || fnArgs.query || fnArgs.url || "";
      onEvent("tool_call", { tool: fnName, args: String(keyArg).slice(0, 150) || JSON.stringify(fnArgs).slice(0, 150) });

      const result = await execTool(fnName, fnArgs, ctx);
      const out = result.stdout ?? result.content ?? result.error ?? JSON.stringify(result);
      onEvent("tool_result", { text: String(out).slice(0, 500) });

      history.push({ role: "tool", tool_call_id: tc.id, name: fnName, content: JSON.stringify(result) });

      if (isCancelled()) throw new CancelledError();
    }

    if (round === MAX_TOOL_ROUNDS) {
      history.push({ role: "user", content: "Tool limit reached. Summarize and give your final answer." });
      const fr = await llmPostRetry(baseUrl, apiKey, {
        model, messages: getMessages(), max_tokens: 8192, temperature: 1.0, top_p: 1.0, stream: false,
      });
      const fm = fr?.choices?.[0]?.message;
      finalContent = fm?.content || fm?.reasoning_content || "";
      history.push({ role: "assistant", content: finalContent });
    }
  }

  return { reply: (finalContent || "").trim(), history };
}

// ── Job storage helpers ───────────────────────────────────────────────────────

async function ghSafeWrite(path, content) {
  try {
    const existing = await ghRead(path);
    await ghWrite(path, content, existing?.sha ?? null);
    return existing?.content ?? null;
  } catch (err) {
    try {
      const fresh = await ghRead(path);
      await ghWrite(path, content, fresh?.sha ?? null);
      return fresh?.content ?? null;
    } catch {}
    return null;
  }
}

const CancelledError = class extends Error { constructor() { super("Cancelled by user"); this.code = "CANCELLED"; } };

// ── Vercel handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { message, sessionId, userApiKey, userProvider, userModel } = req.body ?? {};
  if (!message?.trim() || !sessionId) return res.status(400).json({ error: "missing message or sessionId" });

  const providerKey = userProvider && PROVIDERS[userProvider] ? userProvider : "nvidia";
  const providerInfo = PROVIDERS[providerKey];
  const poolKey = providerKey === "nvidia" ? await nextApiKey().catch(() => DEFAULT_API_KEY) : DEFAULT_API_KEY;
  const providerCfg = {
    apiKey:   userApiKey?.trim() || poolKey,
    baseUrl:  providerInfo.baseUrl,
    model:    userModel?.trim()  || providerInfo.defaultModel,
    provider: providerKey.charAt(0).toUpperCase() + providerKey.slice(1),
  };

  if (!providerCfg.apiKey) {
    return res.status(400).json({ error: "No API key available. Add your key in API Configuration." });
  }

  const jobId  = randomUUID();
  const created = Date.now();
  const jobPath = `sessions/jobs/${jobId}.json`;

  // Initial job record — written before responding so polling works immediately
  const jobBase = {
    id: jobId,
    status: "running",
    message: message.trim(),
    sessionId,
    provider: providerCfg.provider,
    model: providerCfg.model,
    created,
    updated: created,
    rounds: [],
    reply: null,
    error: null,
    durationMs: null,
  };
  await ghSafeWrite(jobPath, JSON.stringify(jobBase, null, 2));

  // ── Respond immediately ────────────────────────────────────────────────────
  res.status(202).json({ jobId, status: "running" });

  // ── Background processing (continues after HTTP response is sent) ──────────
  // Node.js keeps the event loop alive as long as async operations are pending.
  // Vercel Fluid Compute honours this up to maxDuration (300s).

  const rounds = [];
  let currentRound = null;
  let cancelled = false;
  const isCancelled = () => cancelled;

  // Serialized write chain — ensures GitHub writes don't race each other.
  // Also peeks at the previous record to surface cancelRequested back to the
  // agent loop (a different function instance may have set it via /job?action=cancel).
  let writeChain = Promise.resolve();
  const queueWrite = (data) => {
    writeChain = writeChain.then(async () => {
      const prev = await ghSafeWrite(jobPath, JSON.stringify(data, null, 2));
      if (prev) {
        try { if (JSON.parse(prev).cancelRequested) cancelled = true; } catch {}
      }
    }).catch(() => {});
  };

  const onEvent = (type, data) => {
    switch (type) {
      case "round":
        if (currentRound) rounds.push(currentRound);
        currentRound = { round: data.round, thinking: "", toolCalls: [] };
        // Write state after each round starts so progress is visible early
        queueWrite({ ...jobBase, status: "running", rounds: [...rounds, currentRound], updated: Date.now() });
        break;
      case "thinking":
        if (currentRound) currentRound.thinking = data.text;
        break;
      case "tool_call":
        if (currentRound) currentRound.toolCalls.push({ tool: data.tool, args: data.args, result: "" });
        break;
      case "tool_result":
        if (currentRound) {
          const tc = currentRound.toolCalls[currentRound.toolCalls.length - 1];
          if (tc) tc.result = data.text;
        }
        break;
    }
  };

  const heliosOpen = await openHeliosSession(sessionId, {
    baseUrl: providerCfg.baseUrl,
    apiKey:  providerCfg.apiKey,
    model:   providerCfg.model,
  }).catch(() => null);
  const heliosSession = heliosOpen?.session ?? null;

  try {
    const webSessionKey = `web_${sessionId}`;
    const stored = await pullSession(webSessionKey).catch(() => null);
    const history = stored ?? [];

    const { reply, history: updated } = await runAgent(message.trim(), history, onEvent, providerCfg, { sessionId, heliosSession }, isCancelled);
    if (currentRound) rounds.push(currentRound);

    const toSave = updated.filter(m => m.role !== "system").slice(-HISTORY_MAX_MSGS);
    pushSession(webSessionKey, JSON.stringify(toSave, null, 2)).catch(() => {});

    // Persistent memory side-effects (best-effort)
    memoryRecordTurn(sessionId, message.trim(), reply).catch(() => {});
    const llmShim = async (msgs) => {
      const r = await llmPostRetry(providerCfg.baseUrl, providerCfg.apiKey, {
        model: providerCfg.model, messages: msgs, max_tokens: 600, temperature: 0.3, top_p: 1.0, stream: false,
      });
      return r?.choices?.[0]?.message?.content ?? "";
    };
    memoryDistill(sessionId, updated, llmShim).catch(() => {});

    await writeChain;
    await ghSafeWrite(jobPath, JSON.stringify({
      ...jobBase,
      status: "done",
      rounds,
      reply,
      updated: Date.now(),
      durationMs: Date.now() - created,
    }, null, 2));
  } catch (err) {
    const isCancel = err?.code === "CANCELLED";
    if (currentRound) rounds.push(currentRound);
    await writeChain;
    await ghSafeWrite(jobPath, JSON.stringify({
      ...jobBase,
      status: isCancel ? "cancelled" : "error",
      error: isCancel ? null : err.message,
      cancelledAt: isCancel ? Date.now() : undefined,
      rounds,
      updated: Date.now(),
      durationMs: Date.now() - created,
    }, null, 2)).catch(() => {});
  } finally {
    try { await heliosOpen?.close(); } catch {}
  }
}
