# mitmproxy addon: ловит ответ, похожий на подписку (то, что Happ прячет как <hidden>),
# и пишет {url, body} в /tmp/happ_result.json. Служебные хосты Happ/Google/CDN пропускаем.
from mitmproxy import http
import base64
import json

RESULT = "/tmp/happ_result.json"

SKIP = (
    "google.com", "googleapis.com", "gstatic.com", "jsdelivr.net",
    "githubusercontent.com", "clients.google.com", "drive.usercontent.google.com",
    "firebaseinstallations", "crashlytics", "sentry", "ntp2-sync.com",
)


def _looks_like_subscription(text: str) -> bool:
    if not text:
        return False
    if any(s in text for s in ('"outbounds"', "vless://", "vmess://", "trojan://", "ss://")):
        return True
    if text.lstrip().startswith("proxies:") or "\nproxies:" in text:
        return True
    try:
        d = base64.b64decode(text.strip() + "===", validate=False).decode("utf-8", "ignore")
        if "://" in d and any(p in d for p in ("vless", "vmess", "trojan", "ss")):
            return True
    except Exception:
        pass
    return False


def response(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host
    if any(s in host for s in SKIP):
        return
    content = flow.response.content or b""
    if len(content) > 200_000:          # geoip/geosite .dat и прочее крупное
        return
    try:
        text = flow.response.get_text(strict=False)
    except Exception:
        return
    if _looks_like_subscription(text):
        with open(RESULT, "w") as f:
            json.dump({"url": flow.request.pretty_url, "body": text}, f)
