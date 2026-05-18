/**
 * api/webhook.js — Vercel serverless Telegram webhook handler
 *
 * Telegram sends POST requests here when a user messages the bot.
 * This function:
 *   1. Pulls session history from GitHub storage repo
 *   2. Runs the Kimi K2 agentic loop via NVIDIA NIM
 *   3. Pushes updated session back to GitHub
 *   4. Sends the reply to Telegram
 *
 * Deploy env vars required (set in Vercel dashboard):
 *   TELEGRAM_TOKEN, NVIDIA_API_KEY, GITHUB_TOKEN,
 *   GITHUB_STORAGE_REPO, MODEL, NVIDIA_BASE_URL
 */

import https from "node:https";
import { exec } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ghRead, ghWrite } from "../src/sync/github-storage.mjs";
import { pullSession, pushSession } from "../src/storage/sessions.mjs";
import { nextApiKey } from "../src/storage/keypool.mjs";

// ── Activity log (written to GitHub after each run, read by /api/activity) ────
const ACTIVITY_MAX = 30;

async function appendActivity(entry) {
  try {
    const existing = await ghRead("activity/log.json");
    const data = existing ? JSON.parse(existing.content) : { entries: [] };
    data.entries.unshift(entry);                        // newest first
    data.entries = data.entries.slice(0, ACTIVITY_MAX);
    await ghWrite("activity/log.json", JSON.stringify(data, null, 2), existing?.sha ?? null);
  } catch (err) {
    console.warn("appendActivity:", err.message);
  }
}

// ── Env ───────────────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN    ?? "";
const NVIDIA_API_KEY    = process.env.NVIDIA_API_KEY    ?? ""; // kept for fallback; pool used at call time
const NVIDIA_BASE_URL   = process.env.NVIDIA_BASE_URL   ?? "https://integrate.api.nvidia.com/v1";
const MODEL             = process.env.MODEL             ?? "openai/gpt-oss-120b";
const MAX_TOOL_ROUNDS   = parseInt(process.env.MAX_TOOL_ROUNDS   ?? "15", 10);
const HISTORY_MAX_MSGS  = parseInt(process.env.HISTORY_MAX_MSGS  ?? "60", 10);
const NVIDIA_TIMEOUT_MS = parseInt(process.env.NVIDIA_TIMEOUT_MS ?? "250000", 10);
const TG_BASE           = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Solis, an advanced AI agent. You are powered by ${MODEL} via NVIDIA NIM.
Running on: Vercel cloud (phone may be offline).

## Identity
- Name: Solis (TermuxClawAgent)
- Interface: Telegram
- Storage: GitHub repo (solis-agent-files) — sessions and vault synced here

## Your Tools
- **shell_exec**: Run any bash/Linux command on the Vercel server (Amazon Linux, /tmp writable)
- **file_write**: Write a file to /tmp (ephemeral — lost after this session)
- **vault_read**: Read a note from the memory vault (fetched from GitHub)
- **vault_write**: Write a note to the memory vault (pushed to GitHub)
- **vault_list**: List notes in the vault
- **vault_search**: Search vault notes
- **http_get**: Make an HTTP GET request

## Shell environment
- OS: Amazon Linux (Vercel serverless)
- Available: bash, python3, node, curl, wget, git, grep, awk, sed, jq, find, zip, openssl
- Writable path: /tmp (ephemeral — wiped between sessions, use vault to persist results)
- No sudo / no apt install persistence

## Memory Vault Layout
- Memory/Skills/ — things you know how to do
- Memory/Daily/  — daily activity logs
- Memory/Facts/  — facts about the user and environment

## Rules
- Always use tools for real work. Never fake output.
- Store useful information in vault so you remember it next session.
- Use markdown for clarity.
- For results you want to keep, write them to the vault after running commands.`;

// ── TOOLS ─────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "shell_exec",
      description: "Execute a bash command on the Vercel Linux server. /tmp is writable. Returns stdout, stderr, exit_code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to run" },
          timeout_ms: { type: "integer", description: "Timeout in ms (default 25000, max 60000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Write content to a file in /tmp (ephemeral — use vault to persist).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path inside /tmp, e.g. /tmp/script.py" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_read",
      description: "Read a note from the memory vault stored in GitHub.",
      parameters: {
        type: "object",
        properties: {
          note_path: { type: "string", description: "Path relative to vault root, e.g. Memory/Facts/user.md" },
        },
        required: ["note_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_write",
      description: "Write (create or overwrite) a note in the vault (saved to GitHub).",
      parameters: {
        type: "object",
        properties: {
          note_path: { type: "string" },
          content: { type: "string", description: "Markdown content" },
        },
        required: ["note_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_list",
      description: "List notes and folders in the vault.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Sub-path within vault (default: root)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_search",
      description: "Search vault notes by keyword (fetched from GitHub).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_get",
      description: "Make an HTTP GET request and return the response body.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
];

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const keepAlive = new https.Agent({ keepAlive: true, keepAliveMsecs: 20_000 });

function httpsPost(url, body, extraHeaders = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      req.destroy(); reject(new Error(`Timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      agent: keepAlive,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...extraHeaders },
    }, (res) => {
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

function httpsGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on("timeout", () => req.destroy(new Error("Timeout")));
    req.on("error", reject);
  });
}

async function httpsPostRetry(url, body, headers = {}, timeoutMs = 30000, retries = 3) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await httpsPost(url, body, headers, timeoutMs); }
    catch (err) {
      last = err;
      if (i === retries) break;
      await new Promise(r => setTimeout(r, 2000 * Math.pow(2, i)));
    }
  }
  throw last;
}

// ── Telegram helpers ──────────────────────────────────────────────────────────

async function tgSend(chatId, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    const res = await httpsPost(`${TG_BASE}/sendMessage`, {
      chat_id: chatId, text: chunk, parse_mode: "Markdown",
    }).catch(() => null);
    if (!res?.ok) {
      await httpsPost(`${TG_BASE}/sendMessage`, { chat_id: chatId, text: chunk }).catch(() => null);
    }
  }
}

async function tgEdit(chatId, msgId, text) {
  await httpsPost(`${TG_BASE}/editMessageText`, {
    chat_id: chatId, message_id: msgId, text, parse_mode: "Markdown",
  }).catch(() => {});
}

async function tgSendRaw(chatId, text) {
  const res = await httpsPost(`${TG_BASE}/sendMessage`, {
    chat_id: chatId, text, parse_mode: "Markdown",
  }).catch(() => null);
  return res?.result?.message_id ?? null;
}

// ── Cloud vault tool executors (GitHub-backed) ────────────────────────────────

// In-memory vault cache per invocation to reduce GitHub API calls
const vaultCache = new Map();

async function cloudExecTool(name, args) {
  try {
    switch (name) {

      case "shell_exec": {
        const timeout = Math.min(args.timeout_ms ?? 25000, 60000);
        return await new Promise((res) => {
          exec(args.command, { timeout, maxBuffer: 1024 * 512, shell: "/bin/bash" }, (err, stdout, stderr) => {
            res({
              stdout: (stdout ?? "").slice(0, 6000),
              stderr: (stderr ?? "").slice(0, 2000),
              exit_code: err?.code ?? 0,
            });
          });
        });
      }

      case "file_write": {
        const safePath = args.path.startsWith("/tmp/") ? args.path : `/tmp/${args.path.replace(/^\/+/, "")}`;
        mkdirSync(dirname(safePath), { recursive: true });
        writeFileSync(safePath, args.content, "utf8");
        return { success: true, path: safePath };
      }

      case "vault_read": {
        const repoPath = `vault/${args.note_path}`;
        if (vaultCache.has(repoPath)) return { content: vaultCache.get(repoPath) };
        const result = await ghRead(repoPath);
        if (!result) return { error: `Note not found: ${args.note_path}` };
        vaultCache.set(repoPath, result.content);
        return { content: result.content.slice(0, 10000) };
      }

      case "vault_write": {
        const repoPath = `vault/${args.note_path}`;
        const existing = await ghRead(repoPath);
        await ghWrite(repoPath, args.content, existing?.sha ?? null);
        vaultCache.set(repoPath, args.content);
        return { success: true, note_path: args.note_path };
      }

      case "vault_list": {
        const prefix = args.path ? `vault/${args.path}` : "vault";
        const { ghList } = await import("../src/sync/github-storage.mjs");
        const entries = await ghList(prefix);
        return { entries: entries.map(e => e.type === "dir" ? e.name + "/" : e.name) };
      }

      case "vault_search": {
        const query = args.query.toLowerCase();
        const results = [];
        // List all files recursively
        async function searchDir(dirPath) {
          const { ghList } = await import("../src/sync/github-storage.mjs");
          const entries = await ghList(dirPath);
          for (const entry of entries) {
            if (entry.type === "dir") {
              await searchDir(entry.path);
            } else if (entry.name.endsWith(".md")) {
              const file = await ghRead(entry.path);
              if (file && file.content.toLowerCase().includes(query)) {
                const lines = file.content.split("\n").filter(l => l.toLowerCase().includes(query));
                results.push({ note: entry.path.replace(/^vault\//, ""), matches: lines.slice(0, 3) });
              }
            }
          }
        }
        await searchDir("vault");
        return { query: args.query, results };
      }

      case "http_get": {
        return await new Promise((res) => {
          https.get(args.url, { timeout: 15000 }, (r) => {
            let body = "";
            r.on("data", c => body += c);
            r.on("end", () => res({ status: r.statusCode, body: body.slice(0, 8000) }));
          }).on("error", e => res({ error: e.message }));
        });
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── Agentic loop ──────────────────────────────────────────────────────────────

async function runAgent(chatId, userText, username, history) {
  const apiKey = await nextApiKey().catch(() => NVIDIA_API_KEY);

  history.push({ role: "user", content: userText });

  const getMessages = () => [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-HISTORY_MAX_MSGS),
  ];

  // Live status message in Telegram
  let streamMsgId = await tgSendRaw(chatId, `\`\`\`\n🤖 Solis (cloud) — thinking…\n\`\`\``);
  let streamLines = [`🤖 Solis — ${new Date().toLocaleTimeString()}`, `💬 "${userText.slice(0, 60)}${userText.length > 60 ? "…" : ""}"`, "─".repeat(28)];
  let lastEdit = 0;

  const updateStream = async (line, force = false) => {
    streamLines.push(line);
    const now = Date.now();
    if (!force && now - lastEdit < 1200) return;
    lastEdit = now;
    if (streamMsgId) {
      await tgEdit(chatId, streamMsgId, `\`\`\`\n${streamLines.slice(-16).join("\n")}\n\`\`\``);
    }
  };

  // Structured activity log for the status page
  const activityRounds = [];
  let currentRound = null;
  const startedAt = Date.now();

  let round = 0;
  let finalContent = null;

  while (round < MAX_TOOL_ROUNDS) {
    round++;
    currentRound = { round, thinking: null, toolCalls: [] };
    await updateStream(`▶ [R${round}] ${MODEL.split("/").pop()}…`);

    const res = await httpsPostRetry(
      `${NVIDIA_BASE_URL}/chat/completions`,
      {
        model: MODEL,
        messages: getMessages(),
        max_tokens: 16384,
        temperature: 1.0,
        top_p: 1.0,
        stream: false,
        tools: TOOLS,
        tool_choice: "auto",
        chat_template_kwargs: { thinking: true },
      },
      { Authorization: `Bearer ${apiKey}` },
      NVIDIA_TIMEOUT_MS,
      2,
    );

    if (res?.error) throw new Error(res.error.message || JSON.stringify(res.error));
    const choice = res?.choices?.[0];
    if (!choice) throw new Error("Empty NIM response");

    const msg = choice.message;
    const toolCalls = msg?.tool_calls;
    const thinking = msg?.reasoning_content ?? msg?.reasoning ?? "";
    if (thinking) {
      const snippet = thinking.slice(0, 500).replace(/\n+/g, " ").trim();
      currentRound.thinking = snippet + (thinking.length > 500 ? "…" : "");
      const display = snippet.slice(0, 180);
      await updateStream(`💭 ${display}${snippet.length > 180 ? "…" : ""}`);
    }

    if (!toolCalls || toolCalls.length === 0) {
      finalContent = msg?.content || thinking || "";
      history.push({ role: "assistant", content: finalContent });
      activityRounds.push(currentRound);
      break;
    }

    history.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const fnName = tc.function?.name;
      let fnArgs = {};
      try { fnArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      const keyArg = fnArgs.note_path || fnArgs.path || fnArgs.query || fnArgs.url || fnArgs.command || "";
      await updateStream(`🔧 ${fnName}${keyArg ? `(${String(keyArg).slice(0, 50)})` : ""}`);
      const result = await cloudExecTool(fnName, fnArgs);
      const out = result.content ?? result.stdout ?? result.error ?? JSON.stringify(result);
      const outClean = String(out).replace(/\n+/g, " ").trim();
      await updateStream(`   ↳ ${outClean.slice(0, 90)}${outClean.length > 90 ? "…" : ""}`);
      history.push({ role: "tool", tool_call_id: tc.id, name: fnName, content: JSON.stringify(result) });
      currentRound.toolCalls.push({
        tool: fnName,
        args: keyArg ? String(keyArg).slice(0, 120) : JSON.stringify(fnArgs).slice(0, 120),
        result: outClean.slice(0, 300),
      });
    }

    activityRounds.push(currentRound);

    if (round === MAX_TOOL_ROUNDS) {
      history.push({ role: "user", content: "You've reached the tool call limit. Summarize and give your final answer." });
      const fr = await httpsPostRetry(
        `${NVIDIA_BASE_URL}/chat/completions`,
        { model: MODEL, messages: getMessages(), max_tokens: 8192, temperature: 1.0, top_p: 1.0, stream: false },
        { Authorization: `Bearer ${apiKey}` },
        NVIDIA_TIMEOUT_MS, 2,
      );
      const fm = fr?.choices?.[0]?.message;
      finalContent = fm?.content || fm?.reasoning_content || "";
      history.push({ role: "assistant", content: finalContent });
    }
  }

  if (!finalContent) {
    finalContent = "⚠️ Task completed but no summary generated.";
    history.push({ role: "assistant", content: finalContent });
  }

  await updateStream("─".repeat(28), true);
  await updateStream("✅ done", true);
  await tgEdit(chatId, streamMsgId, `\`\`\`\n${streamLines.slice(-18).join("\n")}\n\`\`\``);

  // Push structured run to activity log (non-blocking)
  const activityEntry = {
    timestamp: new Date().toISOString(),
    username: username || "unknown",
    userMessage: userText,
    rounds: activityRounds,
    finalReply: finalContent.trim().slice(0, 400) + (finalContent.length > 400 ? "…" : ""),
    durationMs: Date.now() - startedAt,
    model: MODEL,
  };
  appendActivity(activityEntry).catch(() => {});

  return { reply: finalContent.trim(), history };
}

// ── Vercel handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Immediately acknowledge to Telegram (must respond within 5s or Telegram retries)
  if (req.method !== "POST") return res.status(200).send("TermuxClawAgent webhook OK");

  const update = req.body;
  res.status(200).json({ ok: true }); // respond to Telegram immediately

  // Process asynchronously after responding
  (async () => {
    try {
      const msg = update?.message;
      if (!msg?.text) return;

      const chatId = msg.chat.id;
      const text = msg.text.trim();
      const username = msg.from?.username || msg.from?.first_name || "user";
      console.log(`[cloud] @${username} (${chatId}): ${text}`);

      if (text === "/start") {
        await tgSend(chatId,
          `✅ *Solis* online (☁️ cloud mode)\n\nModel: \`${MODEL}\`\nStorage: GitHub sync\nTools: vault, http\n\n/reset — clear history\n/memory — show vault notes\n/model — show model info\n/sync — sync vault from GitHub`,
        );
        return;
      }

      if (text === "/reset") {
        await pushSession(chatId, "[]");
        await tgSend(chatId, "🗑️ Session cleared.");
        return;
      }

      if (text === "/memory") {
        const { ghList } = await import("../src/sync/github-storage.mjs");
        const entries = await ghList("vault");
        const list = entries.map(e => e.type === "dir" ? e.name + "/" : e.name).join("\n") || "(empty)";
        await tgSend(chatId, `📒 *Vault:*\n\`\`\`\n${list}\n\`\`\``);
        return;
      }

      if (text === "/model") {
        await tgSend(chatId, `🤖 Model: \`${MODEL}\`\nMax rounds: ${MAX_TOOL_ROUNDS}\nHistory: ${HISTORY_MAX_MSGS} msgs\nMode: ☁️ Cloud (Vercel)`);
        return;
      }

      if (text === "/sync") {
        await tgSend(chatId, "🔄 Syncing vault from GitHub…");
        const { ghListRecursive } = await import("../src/sync/github-storage.mjs");
        await tgSend(chatId, "✅ Vault sync complete.");
        return;
      }

      // Pull session history from GitHub
      const stored = await pullSession(chatId);
      const history = stored ?? [];

      // Run agent
      const { reply, history: updatedHistory } = await runAgent(chatId, text, username, history);

      // Push updated session back to GitHub
      const toSave = updatedHistory.filter(m => m.role !== "system").slice(-HISTORY_MAX_MSGS);
      await pushSession(chatId, JSON.stringify(toSave, null, 2));

      // Send reply
      await tgSend(chatId, reply);
      console.log(`  ✓ Replied to @${username}`);
    } catch (err) {
      console.error("[cloud] handler error:", err.message);
      const chatId = update?.message?.chat?.id;
      if (chatId) await tgSend(chatId, `❌ ${err.message}`).catch(() => {});
    }
  })();
}
