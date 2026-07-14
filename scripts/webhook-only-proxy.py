#!/usr/bin/env python3
"""Local webhook-only reverse proxy for public tunnels.

Allows only POST /webhooks/github plus authenticated GET /status and forwards
them to the meta-agent API on 127.0.0.1:4317. Everything else returns 403 so a
generic tunnel does not expose /dashboard or other local routes.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import json
from urllib.parse import urlsplit

UPSTREAM_HOST = "127.0.0.1"
UPSTREAM_PORT = 4317
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 4318
ALLOWED_WEBHOOK_PATH = "/webhooks/github"
ALLOWED_STATUS_PATH = "/status"
MAX_NON_WEBHOOK_DRAIN_BYTES = 64 * 1024

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send_json(self, code: int, body: bytes):
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._drain_non_webhook_body():
            return
        if self._request_path() != ALLOWED_STATUS_PATH:
            self._send_json(403, b'{"ok":false,"error":"Only POST /webhooks/github and GET /status are exposed"}')
            return
        self._proxy("GET", b"")

    def _read_request_body(self) -> bytes:
        length = self._content_length()
        return self.rfile.read(length)

    def _drain_non_webhook_body(self) -> bool:
        length = self._content_length()
        if length > MAX_NON_WEBHOOK_DRAIN_BYTES:
            self.close_connection = True
            self._send_json(413, b'{"ok":false,"error":"Request body too large"}')
            return False
        self.rfile.read(length)
        return True

    def _content_length(self) -> int:
        # Only support requests with a known, non-negative Content-Length.
        # If we can't safely determine the body length, close the connection to
        # avoid leaving unread bytes on a keep-alive socket.
        if self.headers.get("transfer-encoding"):
            self.close_connection = True
            return 0
        try:
            length = int(self.headers.get("content-length") or "0")
        except ValueError:
            self.close_connection = True
            return 0
        if length < 0:
            self.close_connection = True
            return 0
        return length

    def do_POST(self):
        if self._request_path() != ALLOWED_WEBHOOK_PATH:
            # Drain the request body before responding so keep-alive clients do
            # not leave unread bytes on the connection.
            if not self._drain_non_webhook_body():
                return
            self._send_json(403, b'{"ok":false,"error":"Only POST /webhooks/github and GET /status are exposed"}')
            return
        body = self._read_request_body()
        self._proxy("POST", body)

    def _request_path(self) -> str:
        return urlsplit(self.path).path

    def _proxy(self, method: str, body: bytes):
        headers = {k: v for k, v in self.headers.items() if k.lower() not in {"connection", "content-length"}}
        headers["Content-Length"] = str(len(body))
        conn = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=15)
        try:
            conn.request(method, self.path, body=body, headers=headers)
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
    print(f"webhook/status proxy listening on http://{LISTEN_HOST}:{LISTEN_PORT} -> http://{UPSTREAM_HOST}:{UPSTREAM_PORT}", flush=True)
    server.serve_forever()
