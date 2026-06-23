#!/usr/bin/env python3
"""Local webhook-only reverse proxy for public tunnels.

Allows only POST /webhooks/github and forwards it to the meta-agent API on
127.0.0.1:4317. Everything else returns 403 so a generic tunnel does not expose
/dashboard or other local routes.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import json

UPSTREAM_HOST = "127.0.0.1"
UPSTREAM_PORT = 4317
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 4318
ALLOWED_PATH = "/webhooks/github"

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send_json(self, code: int, body: bytes):
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send_json(403, b'{"ok":false,"error":"Only POST /webhooks/github is exposed"}')

    def _read_request_body(self) -> bytes:
        length = int(self.headers.get("content-length") or "0")
        return self.rfile.read(length)

    def do_POST(self):
        if self.path != ALLOWED_PATH:
            # Drain the request body before responding so keep-alive clients do
            # not leave unread bytes on the connection.
            self._read_request_body()
            self._send_json(403, b'{"ok":false,"error":"Only POST /webhooks/github is exposed"}')
            return
        body = self._read_request_body()
        headers = {k: v for k, v in self.headers.items() if k.lower() not in {"host", "connection", "content-length"}}
        headers["Content-Length"] = str(len(body))
        conn = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=15)
        try:
            conn.request("POST", self.path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
            self.send_response(resp.status, resp.reason)
            for k, v in resp.getheaders():
                if k.lower() not in {"connection", "content-length", "keep-alive", "transfer-encoding"}:
                    self.send_header(k, v)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            msg = json.dumps({"ok": False, "error": f"proxy upstream failure: {exc}"}).encode()
            self._send_json(502, msg)
        finally:
            conn.close()

    def log_message(self, format, *args):
        print("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), format % args), flush=True)

if __name__ == "__main__":
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"webhook-only proxy listening on http://{LISTEN_HOST}:{LISTEN_PORT} -> http://{UPSTREAM_HOST}:{UPSTREAM_PORT}{ALLOWED_PATH}", flush=True)
    server.serve_forever()
