#!/usr/bin/env python3
"""Minimal Junos REST API simulator for NetConsole lab."""

from __future__ import annotations

import base64
import json
import os
import ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Ensure import works even if PYTHONPATH is missing
import sys

sys.path.insert(0, "/usr/local/lib/netconsole")

import interface_state
import syslog_buffer


def _load_device_env() -> dict[str, str]:
    values: dict[str, str] = {}
    config_path = "/etc/netconsole/device.env"
    if not os.path.exists(config_path):
        return values

    with open(config_path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


_FILE_ENV = _load_device_env()


def _device_value(key: str, default: str) -> str:
    return os.environ.get(key) or _FILE_ENV.get(key) or default


HOSTNAME = _device_value("DEVICE_HOSTNAME", "lab-jr1")
USER = os.environ.get("LAB_USER", "admin")
PASSWORD = os.environ.get("LAB_PASSWORD", "Admin@123")
REST_PORT = int(os.environ.get("REST_PORT", "8443"))
REST_SCHEME = os.environ.get("REST_SCHEME", "http").lower()


def mac_table_payload() -> dict:
    return interface_state.mac_rest_payload()


def arp_table_payload() -> dict:
    return interface_state.arp_rest_payload()


def log_payload() -> dict:
    return syslog_buffer.rest_payload()


def show_log_text() -> str:
    return syslog_buffer.format_show_log()


class JunosRestHandler(BaseHTTPRequestHandler):
    server_version = "Junos-REST-Sim/0.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        print(f"[junos-rest] {self.address_string()} - {fmt % args}")

    def _unauthorized(self) -> None:
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Junos REST"')
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":"unauthorized"}')

    def _check_auth(self) -> bool:
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header.split(" ", 1)[1]).decode("utf-8")
            username, password = decoded.split(":", 1)
        except Exception:  # noqa: BLE001
            return False
        return username == USER and password == PASSWORD

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        self._handle()

    def do_POST(self) -> None:  # noqa: N802
        self._handle()

    def _handle(self) -> None:
        if not self._check_auth():
            self._unauthorized()
            return

        path = self.path.split("?", 1)[0].rstrip("/")
        if path in {
            "/rpc/get-ethernet-switching-table-information",
            "/rpc/get-ethernet-switching-table-information/",
        }:
            self._json(200, mac_table_payload())
            return

        if path in {
            "/rpc/get-arp-table-information",
            "/rpc/get-arp-table-information/",
        }:
            self._json(200, arp_table_payload())
            return

        if path in {
            "/rpc/get-interface-information",
            "/rpc/get-interface-information/",
        }:
            self._json(200, interface_state.rest_payload())
            return

        if path in {
            "/rpc/get-log-information",
            "/rpc/get-log-information/",
        }:
            self._json(200, log_payload())
            return

        if path == "/cli/show-log":
            body = show_log_text()
            encoded = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return

        if path in {"/", "/rpc"}:
            self._json(
                200,
                {
                    "service": "junos-rest-sim",
                    "hostname": HOSTNAME,
                    "rpcs": [
                        "get-ethernet-switching-table-information",
                        "get-arp-table-information",
                        "get-interface-information",
                        "get-log-information",
                    ],
                },
            )
            return

        self._json(404, {"error": "not found", "path": path})


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", REST_PORT), JunosRestHandler)

    if REST_SCHEME == "https":
        cert = "/etc/netconsole/rest.crt"
        key = "/etc/netconsole/rest.key"
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=cert, keyfile=key)
        server.socket = context.wrap_socket(server.socket, server_side=True)

    print(f"[junos-rest] {HOSTNAME} listening on {REST_SCHEME}://0.0.0.0:{REST_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
