#!/usr/bin/env python3
"""
Tencent K-line CORS proxy for reverse-watch.
Listens on :3021, returns CORS-enabled responses.
GET /kline?code=601077&count=320
GET /health
"""
import http.server
import urllib.request
import urllib.error
import sys

PORT = 3021

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[tencent-proxy] " + fmt % args + "\n")

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Cache-Control", "no-store")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        if u.path == "/health":
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if u.path != "/kline":
            self.send_error(404)
            return

        qs = parse_qs(u.query)
        code = (qs.get("code") or [""])[0]
        count = (qs.get("count") or ["320"])[0]
        if not code or not code.isdigit() or len(code) != 6:
            self.send_error(400, "code must be 6-digit")
            return

        prefix = "sh" if code[0] in "659" else "sz"
        url = f"http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={prefix}{code},day,,,{count},qfq"
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                raw = r.read()
        except urllib.error.URLError as e:
            self.send_error(502, "tencent: " + str(e))
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_cors()
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


if __name__ == "__main__":
    print(f"Tencent K-line proxy on :{PORT}")
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()