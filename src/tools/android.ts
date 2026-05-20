/**
 * AndroidControl - Full Android device control via Termux:API
 *
 * Requires the Termux:API app + `pkg install termux-api` inside Termux.
 * Also provides image_analyze (vision LLM) and pdf_read (pdftotext).
 */

import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Logger } from "../utils/logger.js";
import type { ToolDefinition } from "./registry.js";

const execFileAsync = promisify(execFile);
const execAsync    = promisify(exec);
const logger = new Logger("Android");

async function run(cmd: string, args: string[] = [], input?: string): Promise<any> {
  try {
    const result = await execFileAsync(cmd, args, {
      encoding: "utf8",
      timeout: 30000,
      input,
    } as any) as unknown as { stdout: string; stderr: string };
    const out = (result.stdout || "").trim();
    try { return JSON.parse(out); } catch { return out || result.stderr || "ok"; }
  } catch (err: any) {
    logger.error(`${cmd} failed: ${err.message}`);
    throw new Error(`Android command failed: ${err.message}`);
  }
}

export function getAndroidTools(): ToolDefinition[] {
  const t = (
    name: string,
    description: string,
    parameters: any,
    handler: (a: any) => Promise<any>,
  ): ToolDefinition => ({ name, description, parameters, enabled: true, handler });

  return [
    // ── Device info ──────────────────────────────────────────────────────────
    t("android_battery", "Get battery status (level, plugged, temperature, health).",
      { type: "object", properties: {} },
      async () => run("termux-battery-status")),

    t("android_wifi_info", "Get current WiFi connection info.",
      { type: "object", properties: {} },
      async () => run("termux-wifi-connectioninfo")),

    t("android_wifi_scan", "Scan for nearby WiFi networks.",
      { type: "object", properties: {} },
      async () => run("termux-wifi-scaninfo")),

    t("android_telephony_info", "Get telephony device info (carrier, IMEI, network type).",
      { type: "object", properties: {} },
      async () => run("termux-telephony-deviceinfo")),

    t("android_cell_info", "Get current cell tower info.",
      { type: "object", properties: {} },
      async () => run("termux-telephony-cellinfo")),

    // ── Messaging ────────────────────────────────────────────────────────────
    t("android_sms_send", "Send an SMS message.",
      { type: "object", properties: {
        number: { type: "string" }, text: { type: "string" },
      }, required: ["number", "text"] },
      async (a) => run("termux-sms-send", ["-n", a.number, a.text])),

    t("android_sms_list", "List received SMS messages.",
      { type: "object", properties: { limit: { type: "number" } } },
      async (a) => run("termux-sms-list", ["-l", String(a.limit || 20)])),

    t("android_call", "Place a phone call to a number.",
      { type: "object", properties: { number: { type: "string" } }, required: ["number"] },
      async (a) => run("termux-telephony-call", [a.number])),

    t("android_contacts", "List phone contacts.",
      { type: "object", properties: {} },
      async () => run("termux-contact-list")),

    // ── Notifications & UI ───────────────────────────────────────────────────
    t("android_notification", "Post a system notification.",
      { type: "object", properties: {
        title: { type: "string" }, content: { type: "string" }, id: { type: "string" },
      }, required: ["title", "content"] },
      async (a) => run("termux-notification", [
        "--title", a.title, "--content", a.content, ...(a.id ? ["--id", a.id] : []),
      ])),

    t("android_toast", "Show a toast popup on screen.",
      { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async (a) => run("termux-toast", [a.text])),

    t("android_dialog", "Show an interactive dialog on the Android screen and return user input.",
      {
        type: "object",
        properties: {
          widget: {
            type: "string",
            enum: ["text", "confirm", "date", "time", "radio", "checkbox", "spinner", "counter"],
            description: "Dialog type.",
          },
          title: { type: "string", description: "Dialog title." },
          hint: { type: "string", description: "Input hint / placeholder text." },
          values: { type: "string", description: "Comma-separated values for radio/checkbox/spinner." },
        },
        required: ["widget"],
      },
      async (a) => run("termux-dialog", [
        a.widget,
        ...(a.title  ? ["-t", a.title]  : []),
        ...(a.hint   ? ["-i", a.hint]   : []),
        ...(a.values ? ["-v", a.values] : []),
      ])),

    // ── Media & Sensors ──────────────────────────────────────────────────────
    t("android_vibrate", "Vibrate the device.",
      { type: "object", properties: { duration: { type: "number", description: "ms" } } },
      async (a) => run("termux-vibrate", ["-d", String(a.duration || 500)])),

    t("android_tts", "Speak text aloud via text-to-speech.",
      { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async (a) => run("termux-tts-speak", [a.text])),

    t("android_clipboard_get", "Read the system clipboard.",
      { type: "object", properties: {} },
      async () => run("termux-clipboard-get")),

    t("android_clipboard_set", "Write to the system clipboard.",
      { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async (a) => run("termux-clipboard-set", [a.text])),

    t("android_sensor", "Read a device sensor (accelerometer, gyroscope, etc.).",
      { type: "object", properties: {
        sensor: { type: "string" }, samples: { type: "number" },
      }, required: ["sensor"] },
      async (a) => run("termux-sensor", ["-s", a.sensor, "-n", String(a.samples || 1)])),

    t("android_location", "Get GPS/network location.",
      { type: "object", properties: {
        provider: { type: "string", enum: ["gps", "network", "passive"] },
      } },
      async (a) => run("termux-location", a.provider ? ["-p", a.provider] : [])),

    // ── Camera ───────────────────────────────────────────────────────────────
    t("android_camera_photo", "Capture a photo from the device camera.",
      { type: "object", properties: {
        path: { type: "string" }, camera: { type: "string", enum: ["0", "1"] },
      }, required: ["path"] },
      async (a) => run("termux-camera-photo", ["-c", a.camera || "0", a.path])),

    t("android_camera_info", "List available cameras.",
      { type: "object", properties: {} },
      async () => run("termux-camera-info")),

    // ── Microphone ───────────────────────────────────────────────────────────
    t("android_microphone_record", "Record audio from the microphone to a file.",
      {
        type: "object",
        properties: {
          path: { type: "string", description: "Output file path (.m4a, .mp3)." },
          duration_ms: { type: "number", description: "Recording duration in milliseconds." },
          bitrate: { type: "number", description: "Bitrate in bits/second (default: 128000)." },
        },
        required: ["path"],
      },
      async (a) => run("termux-microphone-record", [
        "-f", a.path,
        ...(a.duration_ms ? ["-d", String(a.duration_ms)] : []),
        ...(a.bitrate ? ["-b", String(a.bitrate)] : []),
      ])),

    // ── Audio ────────────────────────────────────────────────────────────────
    t("android_media_player", "Control media player (play/pause/stop/info).",
      { type: "object", properties: {
        action: { type: "string", enum: ["play", "pause", "stop", "info"] },
        file: { type: "string" },
      }, required: ["action"] },
      async (a) => run("termux-media-player", a.file ? ["play", a.file] : [a.action])),

    t("android_media_scan", "Refresh the Android media library for a file or directory.",
      { type: "object", properties: {
        path: { type: "string", description: "File or directory path to scan." },
      }, required: ["path"] },
      async (a) => run("termux-media-scan", [a.path])),

    t("android_volume", "Get or set a volume stream (music, ring, call, system, notification).",
      { type: "object", properties: {
        stream: { type: "string" }, level: { type: "number" },
      } },
      async (a) => run("termux-volume", a.stream ? [a.stream, String(a.level)] : [])),

    // ── Display ──────────────────────────────────────────────────────────────
    t("android_brightness", "Set screen brightness (0–255 or 'auto').",
      { type: "object", properties: { level: { type: "string" } }, required: ["level"] },
      async (a) => run("termux-brightness", [a.level])),

    t("android_torch", "Toggle the device flashlight/torch.",
      { type: "object", properties: {
        on: { type: "boolean", description: "true = on, false = off." },
      }, required: ["on"] },
      async (a) => run("termux-torch", [a.on ? "on" : "off"])),

    // ── Call Log (dual-SIM aware) ─────────────────────────────────────────────
    t("android_call_log", "Retrieve the device call log. Supports dual-SIM via sim_slot filter.",
      {
        type: "object",
        properties: {
          limit:    { type: "number", description: "Max entries to return (default 20)." },
          type:     { type: "string", enum: ["all", "incoming", "outgoing", "missed"], description: "Filter by call type." },
          sim_slot: { type: "number", enum: [0, 1], description: "Dual-SIM slot index (0 = primary, 1 = secondary)." },
          offset:   { type: "number", description: "Skip first N entries (for pagination)." },
        },
      },
      async (a) => run("termux-call-log", [
        "-l", String(a.limit  ?? 20),
        "-o", String(a.offset ?? 0),
        ...(a.type     ? ["-t", a.type]       : []),
        ...(a.sim_slot != null ? ["-s", String(a.sim_slot)] : []),
      ])),

    // ── Wake Lock ─────────────────────────────────────────────────────────────
    t("android_wake_lock", "Acquire a partial wake lock so Android does not suspend the process.",
      { type: "object", properties: {} },
      async () => run("termux-wake-lock")),

    t("android_wake_unlock", "Release the previously acquired wake lock.",
      { type: "object", properties: {} },
      async () => run("termux-wake-unlock")),

    // ── Notification management ───────────────────────────────────────────────
    t("android_notification_list", "List active notifications posted by Termux.",
      { type: "object", properties: {} },
      async () => run("termux-notification-list")),

    t("android_notification_remove", "Remove (cancel) a Termux notification by ID.",
      { type: "object", properties: { id: { type: "string", description: "Notification ID to remove." } }, required: ["id"] },
      async (a) => run("termux-notification-remove", [a.id])),

    t("android_notification_channel", "Create or update an Android notification channel (required for Android 8+).",
      {
        type: "object",
        properties: {
          id          : { type: "string", description: "Channel ID (unique, e.g. 'agent-status')." },
          name        : { type: "string", description: "Human-readable channel name." },
          description : { type: "string", description: "Channel description shown in system settings." },
          importance  : { type: "string", enum: ["none", "min", "low", "default", "high"], description: "Importance level (controls sound/heads-up)." },
        },
        required: ["id", "name"],
      },
      async (a) => run("termux-notification", [
        "--channel",     a.id,
        "--channel-name", a.name,
        ...(a.description ? ["--channel-description", a.description] : []),
        ...(a.importance  ? ["--importance",          a.importance]  : []),
        // Post a silent dummy notification to create the channel
        "--title", "channel-init", "--content", "", "--priority", "min",
      ])),

    // ── Job Scheduler (Android 10+ background work) ───────────────────────────
    t("android_job_schedule", "Schedule a one-off or periodic background task via Android JobScheduler. Useful on Android 10+ where background execution is restricted.",
      {
        type: "object",
        properties: {
          script    : { type: "string", description: "Shell command or script path to run." },
          delay_ms  : { type: "number", description: "Minimum delay before execution (milliseconds)." },
          network   : { type: "string", enum: ["any", "unmetered", "none"], description: "Network requirement." },
          charging  : { type: "boolean", description: "Require device to be charging." },
          persistent: { type: "boolean", description: "Persist across reboots." },
        },
        required: ["script"],
      },
      async (a) => {
        const args = [a.script];
        if (a.delay_ms   != null) args.push("--delay",     String(a.delay_ms));
        if (a.network)             args.push("--network",   a.network);
        if (a.charging)            args.push("--require-charging");
        if (a.persistent)          args.push("--persist");
        return run("termux-job-scheduler", args);
      }),

    // ── System ───────────────────────────────────────────────────────────────
    t("android_open", "Open a URL, file, or intent on the device.",
      { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      async (a) => run("termux-open", [a.target])),

    t("android_share", "Share text or a file via the Android share sheet.",
      { type: "object", properties: {
        text: { type: "string" }, file: { type: "string" },
      } },
      async (a) => a.file
        ? run("termux-share", [a.file])
        : run("termux-share", [], a.text)),

    t("android_download", "Download a URL via the system DownloadManager.",
      { type: "object", properties: {
        url: { type: "string" }, title: { type: "string" },
      }, required: ["url"] },
      async (a) => run("termux-download", a.title ? ["-t", a.title, a.url] : [a.url])),

    t("android_fingerprint", "Request fingerprint authentication.",
      { type: "object", properties: { title: { type: "string" } } },
      async (a) => run("termux-fingerprint", a.title ? ["-t", a.title] : [])),

    // ── AI Vision ────────────────────────────────────────────────────────────
    t("image_analyze", "Analyze an image file using a vision-capable AI model (Claude or GPT-4o). Returns a description of the image contents.",
      {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to image file (jpg/png/webp/gif)." },
          question: { type: "string", description: "What to look for or ask about the image." },
          model: { type: "string", description: "Model to use (default: claude-sonnet-4-6). Use any vision-capable model." },
        },
        required: ["path"],
      },
      async (a: { path: string; question?: string; model?: string }) => {
        if (!existsSync(a.path)) throw new Error(`Image not found: ${a.path}`);

        const imgBytes = await readFile(a.path);
        const b64 = imgBytes.toString("base64");
        const ext = a.path.split(".").pop()?.toLowerCase() ?? "jpeg";
        const mimeMap: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg",
          png: "image/png", gif: "image/gif", webp: "image/webp",
        };
        const mediaType = mimeMap[ext] ?? "image/jpeg";
        const model = a.model ?? "claude-sonnet-4-6";
        const question = a.question ?? "Describe what you see in this image in detail.";

        // Use Anthropic API directly (Claude vision)
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set — required for image_analyze");

        const body = {
          model,
          max_tokens: 1024,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
              { type: "text", text: question },
            ],
          }],
        };

        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2024-10-22",
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Vision API error (${res.status}): ${err}`);
        }

        const data: any = await res.json();
        const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
        return { analysis: text, model, path: a.path, question };
      }),

    // ── PDF Reader ───────────────────────────────────────────────────────────
    t("pdf_read", "Extract text from a PDF file using pdftotext (pkg install poppler).",
      {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the PDF file." },
          first_page: { type: "number", description: "First page to extract (1-based, default: 1)." },
          last_page: { type: "number", description: "Last page to extract (default: all)." },
          max_chars: { type: "number", description: "Max characters to return (default: 20000)." },
        },
        required: ["path"],
      },
      async (a: { path: string; first_page?: number; last_page?: number; max_chars?: number }) => {
        if (!existsSync(a.path)) throw new Error(`PDF not found: ${a.path}`);
        const maxChars = a.max_chars ?? 20000;

        const args: string[] = [];
        if (a.first_page) args.push("-f", String(a.first_page));
        if (a.last_page)  args.push("-l", String(a.last_page));
        args.push(a.path, "-"); // output to stdout

        try {
          const { stdout } = await execFileAsync("pdftotext", args, { encoding: "utf8", timeout: 30000 });
          const truncated = stdout.length > maxChars;
          return {
            text: stdout.slice(0, maxChars),
            truncated,
            total_chars: stdout.length,
            path: a.path,
          };
        } catch (err: any) {
          if (err.message.includes("ENOENT") || err.message.includes("not found")) {
            throw new Error("pdftotext not installed. Run: pkg install poppler");
          }
          throw new Error(`PDF read failed: ${err.message}`);
        }
      }),
  ];
}
