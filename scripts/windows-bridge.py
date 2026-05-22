#!/usr/bin/env python3
"""
TermuxClawAgent — Windows Desktop Bridge
Runs on your Windows 10 machine and gives the AI agent full desktop control.

Install deps: pip install flask pyautogui Pillow psutil
Run:  python windows-bridge.py --token your-secret-token
Then set WINDOWS_BRIDGE_URL=https://your-ip:5000 and WINDOWS_BRIDGE_TOKEN in Vercel.

Security: ALWAYS set --token. Expose only via a VPN, reverse proxy, or ngrok tunnel.
"""

import argparse
import base64
import io
import platform
import subprocess
import sys
import time

from flask import Flask, jsonify, request, abort

try:
    import pyautogui
    import PIL.ImageGrab as ImageGrab
except ImportError:
    print("Missing deps — run: pip install flask pyautogui Pillow psutil")
    sys.exit(1)

pyautogui.FAILSAFE = False   # disable corner-to-abort so agent can work freely
pyautogui.PAUSE = 0.05       # small pause between actions

app = Flask(__name__)
AUTH_TOKEN = None

# ── Auth ───────────────────────────────────────────────────────────────────────

def check_auth():
    if AUTH_TOKEN:
        tok = request.headers.get("X-Bridge-Token") or request.args.get("token", "")
        if tok != AUTH_TOKEN:
            abort(401, description="Invalid bridge token")

# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    return jsonify({"status": "ok", "os": platform.system(), "version": platform.version()})

@app.route("/info")
def info():
    check_auth()
    w, h = pyautogui.size()
    return jsonify({
        "os": platform.system(),
        "os_version": platform.version(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "screen_width": w,
        "screen_height": h,
    })

@app.route("/screenshot", methods=["GET", "POST"])
def screenshot():
    check_auth()
    scale = float(request.args.get("scale", "0.7"))
    img = ImageGrab.grab(all_screens=False)
    w, h = img.size
    new_w = int(w * scale)
    new_h = int(h * scale)
    img = img.resize((new_w, new_h))
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True, compress_level=6)
    b64 = base64.b64encode(buf.getvalue()).decode()
    return jsonify({"screenshot": b64, "width": new_w, "height": new_h, "orig_width": w, "orig_height": h})

@app.route("/click", methods=["POST"])
def click():
    check_auth()
    d = request.json or {}
    x, y = int(d.get("x", 0)), int(d.get("y", 0))
    btn = d.get("button", "left")
    double = bool(d.get("double", False))
    if double:
        pyautogui.doubleClick(x, y, button=btn)
    else:
        pyautogui.click(x, y, button=btn)
    time.sleep(0.15)
    return jsonify({"ok": True, "x": x, "y": y, "button": btn, "double": double})

@app.route("/rightclick", methods=["POST"])
def rightclick():
    check_auth()
    d = request.json or {}
    x, y = int(d.get("x", 0)), int(d.get("y", 0))
    pyautogui.rightClick(x, y)
    time.sleep(0.15)
    return jsonify({"ok": True})

@app.route("/move", methods=["POST"])
def move():
    check_auth()
    d = request.json or {}
    x, y = int(d.get("x", 0)), int(d.get("y", 0))
    pyautogui.moveTo(x, y, duration=0.3)
    return jsonify({"ok": True})

@app.route("/drag", methods=["POST"])
def drag():
    check_auth()
    d = request.json or {}
    x1, y1 = int(d.get("x1", 0)), int(d.get("y1", 0))
    x2, y2 = int(d.get("x2", 0)), int(d.get("y2", 0))
    pyautogui.moveTo(x1, y1, duration=0.2)
    pyautogui.dragTo(x2, y2, duration=0.4, button="left")
    return jsonify({"ok": True})

@app.route("/type", methods=["POST"])
def type_text():
    check_auth()
    d = request.json or {}
    text = d.get("text", "")
    interval = float(d.get("interval", 0.03))
    # Use pyperclip for non-ASCII text; fall back to typewrite
    try:
        import pyperclip
        pyperclip.copy(text)
        pyautogui.hotkey("ctrl", "v")
    except Exception:
        pyautogui.typewrite(text, interval=interval)
    time.sleep(0.1)
    return jsonify({"ok": True, "length": len(text)})

@app.route("/key", methods=["POST"])
def press_key():
    check_auth()
    d = request.json or {}
    key = d.get("key", "")
    presses = int(d.get("presses", 1))
    if key:
        pyautogui.press(key, presses=presses, interval=0.05)
    return jsonify({"ok": True, "key": key})

@app.route("/hotkey", methods=["POST"])
def hotkey():
    check_auth()
    d = request.json or {}
    keys = d.get("keys", [])
    if isinstance(keys, str):
        keys = [k.strip() for k in keys.split("+")]
    if keys:
        pyautogui.hotkey(*keys)
    return jsonify({"ok": True, "keys": keys})

@app.route("/scroll", methods=["POST"])
def scroll():
    check_auth()
    d = request.json or {}
    x, y = int(d.get("x", 0)), int(d.get("y", 0))
    clicks = int(d.get("clicks", 3))
    pyautogui.scroll(clicks, x=x, y=y)
    return jsonify({"ok": True})

@app.route("/run", methods=["POST"])
def run_command():
    check_auth()
    d = request.json or {}
    command = d.get("command", "")
    timeout = int(d.get("timeout_ms", 30000)) // 1000
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return jsonify({"stdout": result.stdout[:5000], "stderr": result.stderr[:1000], "returncode": result.returncode})
    except subprocess.TimeoutExpired:
        return jsonify({"error": f"Command timed out after {timeout}s"})
    except Exception as e:
        return jsonify({"error": str(e)})

@app.route("/powershell", methods=["POST"])
def powershell():
    check_auth()
    d = request.json or {}
    script = d.get("script", "")
    timeout = int(d.get("timeout_ms", 30000)) // 1000
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=timeout
        )
        return jsonify({"stdout": result.stdout[:5000], "stderr": result.stderr[:1000], "returncode": result.returncode})
    except Exception as e:
        return jsonify({"error": str(e)})

@app.route("/open", methods=["POST"])
def open_app():
    """Launch an application by name (e.g. notepad, chrome, cmd)"""
    check_auth()
    d = request.json or {}
    app_name = d.get("app", "")
    if not app_name:
        return jsonify({"error": "missing app name"})
    try:
        subprocess.Popen(app_name, shell=True)
        time.sleep(1.5)
        return jsonify({"ok": True, "launched": app_name})
    except Exception as e:
        return jsonify({"error": str(e)})

# ── Error handlers ─────────────────────────────────────────────────────────────

@app.errorhandler(401)
def unauthorized(e):
    return jsonify({"error": "Unauthorized", "hint": "Check your bridge token"}), 401

@app.errorhandler(Exception)
def handle_exception(e):
    return jsonify({"error": str(e)}), 500

# ── Main ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="TermuxClawAgent Windows Bridge")
    parser.add_argument("--port", type=int, default=5000, help="Port to listen on")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--token", default="", help="Secret auth token (strongly recommended)")
    args = parser.parse_args()

    AUTH_TOKEN = args.token or None

    print("=" * 60)
    print("  TermuxClawAgent — Windows Desktop Bridge")
    print("=" * 60)
    print(f"  Listening : http://{args.host}:{args.port}")
    if AUTH_TOKEN:
        print(f"  Auth token: {AUTH_TOKEN}")
        print(f"  Set in Vercel: WINDOWS_BRIDGE_TOKEN={AUTH_TOKEN}")
    else:
        print("  ⚠ WARNING: No auth token — set --token for security!")
    screen_w, screen_h = pyautogui.size()
    print(f"  Screen    : {screen_w}x{screen_h}")
    print(f"  OS        : {platform.system()} {platform.version()}")
    print("=" * 60)
print("  Set in Vercel: WINDOWS_BRIDGE_URL=https://YOUR_IP_HERE:" + str(args.port))
    print("=" * 60)

    app.run(host=args.host, port=args.port, threaded=True)
