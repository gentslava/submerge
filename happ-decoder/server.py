#!/usr/bin/env python3
"""happ-decoder — HTTP-обёртка вокруг официального бинаря Happ.

POST /decode {"link": "happ://crypt5/..."} -> {"ok": true, "url": "...", "body": "..."}

Внутри: запускает Happ --test-crypt5 <link> headless (Xvfb) через локальный
mitmproxy; addon перехватывает декодированный sub-URL и тело подписки.
"""
import json
import os
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HAPP_BIN = "/happ/bin/Happ"
PROXY_PORT = 8081
API_PORT = int(os.environ.get("PORT", "8080"))
RESULT = "/tmp/happ_result.json"
HOME = os.environ.get("HOME", "/work")
TIMEOUT = int(os.environ.get("DECODE_TIMEOUT", "45"))
_lock = threading.Lock()


def start_mitm():
    subprocess.Popen(
        ["mitmdump", "-q", "-s", "/app/mitm_capture.py", "-p", str(PROXY_PORT), "--set", "ssl_insecure=true"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def start_xvfb():
    # прямой Xvfb надёжнее xvfb-run (тот требует xauth).
    # docker restart preserves /tmp: a stale .X99-lock (whose recorded pid may
    # belong to a live early-boot process after the restart) makes Xvfb abort
    # silently — and every decode times out. The display is ours: clear its artifacts.
    for stale in ("/tmp/.X99-lock", "/tmp/.X11-unix/X99"):
        try:
            os.remove(stale)
        except OSError:
            pass
    subprocess.Popen(
        ["Xvfb", ":99", "-screen", "0", "1024x768x24"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def _kill_happ():
    # Happ поднимает daemon happd, который переживает родителя — убиваем всё жёстко
    for pat in ("/happ/bin/Happ", "happd"):
        subprocess.run(["pkill", "-9", "-f", pat], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _read_hwid():
    try:
        with open("/mihomo/hwid.txt") as f:
            return f.read().strip()
    except OSError:
        return os.environ.get("SUBMERGE_HWID", "")


def _set_hwid_inject(use_hwid: bool):
    try:
        if use_hwid:
            h = _read_hwid()
            if h:
                with open("/tmp/inject_hwid", "w") as f:
                    f.write(h)
                return
        os.remove("/tmp/inject_hwid")
    except OSError:
        pass


def _reset_happ_state():
    for p in (f"{HOME}/.config/Happ", f"{HOME}/.config/Happ.conf", f"{HOME}/.local/share/Happ"):
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass


def decode(link: str, use_hwid: bool = False):
    _kill_happ()                 # подчищаем процессы от прошлого запроса
    try:
        os.remove(RESULT)
    except FileNotFoundError:
        pass
    _reset_happ_state()
    _set_hwid_inject(use_hwid)   # включаем/выключаем инжект X-Hwid через mitmproxy

    env = dict(os.environ)
    env.update({
        "HOME": HOME,
        "LD_LIBRARY_PATH": "/happ/lib",
        "QT_QPA_PLATFORM": "xcb",
        "http_proxy": f"http://127.0.0.1:{PROXY_PORT}",
        "https_proxy": f"http://127.0.0.1:{PROXY_PORT}",
        "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
        "DISPLAY": ":99",
    })
    proc = subprocess.Popen(
        [HAPP_BIN, "--test-crypt5", link],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + TIMEOUT
    result = None
    while time.time() < deadline:
        if os.path.exists(RESULT):
            try:
                with open(RESULT) as f:
                    result = json.load(f)
                break
            except Exception:
                pass
        time.sleep(0.5)
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    _kill_happ()                 # гарантированно убираем Happ/happd после запроса
    return result


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/decode":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("content-length", "0"))
            data = json.loads(self.rfile.read(n))
            link = data["link"]
            use_hwid = bool(data.get("hwid"))
        except Exception:
            return self._send(400, {"error": "ожидается тело {\"link\": \"happ://...\"}"})
        if not isinstance(link, str) or not link.startswith("happ://"):
            return self._send(400, {"error": "ссылка должна начинаться с happ://"})
        with _lock:
            res = decode(link, use_hwid)
        if not res:
            return self._send(502, {"ok": False, "error": "не удалось декодировать (таймаут / подписка не перехвачена)"})
        self._send(200, {"ok": True, **res})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    os.makedirs(HOME, exist_ok=True)
    start_xvfb()
    start_mitm()
    time.sleep(3)
    print(f"happ-decoder: API :{API_PORT}, proxy :{PROXY_PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", API_PORT), Handler).serve_forever()
