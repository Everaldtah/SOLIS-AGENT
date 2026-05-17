/**
 * ubuntu-sandbox.mjs — DEPRECATED.
 *
 * Sandbox execution has moved to the HELIOS harness
 * (src/tools/helios-integration.mjs). This file remains as a thin
 * back-compat shim so any module that still imports `ubuntuExec`,
 * `ubuntuSandboxAvailable`, or `ubuntuSandboxBackend` keeps working
 * during the transition. Remove in the next release.
 */

import { openHeliosSession } from "./helios-integration.mjs";

export function ubuntuSandboxAvailable() {
  return Boolean(process.env.E2B_API_KEY);
}

export function ubuntuSandboxBackend() {
  return process.env.E2B_API_KEY ? "helios-e2b" : "unconfigured";
}

/**
 * Legacy entrypoint used by old code paths. New code should open a
 * HeliosSession and call `session.exec("shell", { command })` directly.
 * This shim spins up a one-shot session keyed by a synthetic id; for
 * proper session-sticky behavior, switch the caller to HELIOS.
 */
export async function ubuntuExec(command, opts = {}) {
  if (!command || typeof command !== "string") {
    return { error: "ubuntu_exec: missing command" };
  }
  if (!process.env.E2B_API_KEY) {
    return {
      error:
        "ubuntu_exec: E2B_API_KEY not set. HELIOS routes all shell calls " +
        "through E2B Linux sandboxes; set the key in Vercel env.",
    };
  }

  const providerCfg = {
    baseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    apiKey:  process.env.NVIDIA_API_KEY  || "",
    model:   process.env.MODEL           || "meta/llama-3.3-70b-instruct",
  };

  const synthSessionId = `legacy_${Date.now().toString(36)}`;
  const open = await openHeliosSession(synthSessionId, providerCfg);
  try {
    const { collect } = await import("@everaldtah/helios");
    const r = await collect(
      open.session.exec("shell", { command, timeout_ms: opts.timeout_ms })
    );
    const result = (r.result && typeof r.result === "object") ? r.result : {};
    return {
      stdout: String(result.stdout ?? r.stdout ?? "").slice(0, 8000),
      stderr: String(result.stderr ?? r.stderr ?? "").slice(0, 4000),
      exit_code: result.exit_code ?? 0,
      backend: "helios-e2b",
    };
  } catch (err) {
    return { error: `ubuntu_exec via helios failed: ${err.message}`, backend: "helios-e2b" };
  } finally {
    try { await open.close(); } catch {}
  }
}

export async function closeUbuntuSandbox() { /* HELIOS manages lifecycle */ }
