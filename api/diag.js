/**
 * api/diag.js — health-check endpoint
 *
 * GET /diag → reports presence of critical env vars, storage repo target,
 * pool size, and which features the cloud agent thinks are available.
 * Does NOT leak any key values.
 */

import https from "node:https";
import { poolSize, nextApiKey } from "../src/storage/keypool.mjs";
import { ubuntuSandboxAvailable, ubuntuSandboxBackend } from "../src/tools/ubuntu-sandbox.mjs";
import { HELIOS_VERSION } from "@everaldtah/helios";

function nimPing(model, apiKey, timeoutMs = 18000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const body = JSON.stringify({
      model, max_tokens: 8, temperature: 0,
      messages: [{ role: "user", content: "say ok" }],
      stream: false,
    });
    const u = new URL("https://integrate.api.nvidia.com/v1/chat/completions");
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      try { req.destroy(); } catch {}
      resolve({ ok: false, ms: Date.now() - t0, error: `client timeout ${timeoutMs}ms` });
    }, timeoutMs);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${apiKey}`,
      },
    }, r => {
      let raw = "";
      r.on("data", c => raw += c);
      r.on("end", () => {
        if (settled) return; settled = true; clearTimeout(timer);
        try {
          const j = JSON.parse(raw);
          resolve({
            ok: !j.error && Boolean(j?.choices?.[0]),
            ms: Date.now() - t0,
            content: j?.choices?.[0]?.message?.content?.slice(0, 80) ?? null,
            error: j?.error?.message ?? null,
            status: r.statusCode,
          });
        } catch {
          resolve({ ok: false, ms: Date.now() - t0, status: r.statusCode, error: raw.slice(0, 200) });
        }
      });
    });
    req.on("error", e => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ok: false, ms: Date.now() - t0, error: e.message });
    });
    req.write(body); req.end();
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).end();

  const has = (k) => Boolean(process.env[k] && String(process.env[k]).trim().length);
  const NVIDIA_KEY_NAMES = Object.keys(process.env).filter(k => /^NVIDIA_API_KEY\d*$/.test(k) || /^NVIDIA_KEY_[A-Z0-9_]+$/.test(k));

  // Optional: ping=<model[,model2,...]> runs a short health-check call against
  // each model using a key pulled from the pool. Lets the operator confirm
  // which models actually answer with the keys configured on Vercel.
  let pings = null;
  if (req.query?.ping) {
    const models = String(req.query.ping).split(",").map(s => s.trim()).filter(Boolean).slice(0, 6);
    const key = await nextApiKey().catch(() => "");
    if (!key) {
      pings = { error: "no NIM key available in pool" };
    } else {
      // Run in parallel with a tight per-call timeout so the whole endpoint
      // returns well within the function's maxDuration even if some models hang.
      const results = await Promise.all(models.map(m => nimPing(m, key, 12000).then(r => [m, r])));
      pings = Object.fromEntries(results);
    }
  }

  res.status(200).json({
    ok: true,
    storage: {
      repo: process.env.GITHUB_STORAGE_REPO || "Everaldtah/solis-agent-files",
      branch: process.env.GITHUB_STORAGE_BRANCH || "main",
      tokenSet: has("GITHUB_TOKEN"),
    },
    model: {
      coordinator: process.env.MODEL || "openai/gpt-oss-120b",
      baseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    },
    keys: {
      poolSize: poolSize(),
      keyVars: NVIDIA_KEY_NAMES.sort(),
      nvidia_api_key_set: has("NVIDIA_API_KEY"),
    },
    bridge: {
      windows_bridge_configured: has("WINDOWS_BRIDGE_URL"),
    },
    ubuntu_sandbox: {
      available: ubuntuSandboxAvailable(),
      backend: ubuntuSandboxBackend(),
      e2b_key_set: has("E2B_API_KEY"),
      remote_bridge_set: has("UBUNTU_BRIDGE_URL"),
    },
    helios: {
      version: HELIOS_VERSION,
      template: process.env.HELIOS_E2B_TEMPLATE || "helios-base",
      e2b_key_set: has("E2B_API_KEY"),
    },
    runtime: {
      node: process.version,
      region: process.env.VERCEL_REGION || null,
    },
    pings,
  });
}
