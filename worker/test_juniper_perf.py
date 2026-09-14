"""
Test NETCONF vs RESTCONF performance on Juniper 10.10.20.102.
Run from worker/ directory:  python test_juniper_perf.py
"""

import sys
import time
import os

# Add worker to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

from netconsole_worker.junos_netconf import (
    fetch_system_uptime as nc_fetch_uptime,
    fetch_interface_configuration as nc_fetch_iface,
    fetch_full_configuration as nc_fetch_full,
)
from netconsole_worker.junos_rest import (
    fetch_junos_rpc as rest_fetch_rpc,
    fetch_configuration as rest_fetch_config,
)


HOST = "10.10.20.102"
USER = "netconsole"
PASS = "Admin@123"
NC_PORT = 830
REST_PORT = 8443


def hr_ms(ms: int) -> str:
    if ms >= 1000:
        return f"{ms/1000:.1f}s"
    return f"{ms}ms"


def test_netconf_uptime():
    print("\n[NETCONF] get-system-uptime-information")
    t0 = time.monotonic()
    result = nc_fetch_uptime(
        HOST,
        username=USER,
        password=PASS,
        port=NC_PORT,
        timeout=30.0,
    )
    elapsed = int((time.monotonic() - t0) * 1000)
    ok = result.get("ok")
    err = result.get("error") or ""
    raw = result.get("raw") or ""
    print(f"  OK={ok}  elapsed={hr_ms(elapsed)}  error={err[:120]}")
    if raw:
        print(f"  raw (first 400): {raw[:400]}")
    return ok, elapsed


def test_netconf_interface():
    print("\n[NETCONF] get-configuration (interface ge-0/0/0)")
    t0 = time.monotonic()
    result = nc_fetch_iface(
        HOST,
        "ge-0/0/0",
        username=USER,
        password=PASS,
        port=NC_PORT,
        timeout=30.0,
    )
    elapsed = int((time.monotonic() - t0) * 1000)
    ok = result.get("ok")
    err = result.get("error") or ""
    raw = result.get("raw") or ""
    print(f"  OK={ok}  elapsed={hr_ms(elapsed)}  error={err[:120]}")
    if raw:
        print(f"  raw (first 400): {raw[:400]}")
    return ok, elapsed


def test_netconf_full_config():
    print("\n[NETCONF] get-configuration format=set (full candidate)")
    t0 = time.monotonic()
    result = nc_fetch_full(
        HOST,
        username=USER,
        password=PASS,
        port=NC_PORT,
        timeout=60.0,
    )
    elapsed = int((time.monotonic() - t0) * 1000)
    ok = result.get("ok")
    err = result.get("error") or ""
    raw = result.get("raw") or ""
    print(f"  OK={ok}  elapsed={hr_ms(elapsed)}  error={err[:120]}")
    if raw:
        print(f"  raw length={len(raw)} chars")
    return ok, elapsed


def test_restconf_uptime():
    print("\n[RESTCONF] get-system-uptime-information")
    t0 = time.monotonic()
    result = rest_fetch_rpc(
        HOST,
        "get-system-uptime-information",
        username=USER,
        password=PASS,
        scheme="http",
        port=REST_PORT,
        verify_tls=False,
        timeout=30.0,
    )
    elapsed = int((time.monotonic() - t0) * 1000)
    ok = result.get("ok")
    err = result.get("error") or ""
    raw = result.get("raw") or ""
    print(f"  OK={ok}  elapsed={hr_ms(elapsed)}  error={err[:120]}")
    if raw:
        print(f"  raw (first 400): {raw[:400]}")
    return ok, elapsed


def test_restconf_config():
    print("\n[RESTCONF] get-configuration")
    t0 = time.monotonic()
    result = rest_fetch_config(
        HOST,
        username=USER,
        password=PASS,
        scheme="http",
        port=REST_PORT,
        verify_tls=False,
        timeout=60.0,
    )
    elapsed = int((time.monotonic() - t0) * 1000)
    ok = result.get("ok")
    err = result.get("error") or ""
    raw = result.get("raw") or ""
    print(f"  OK={ok}  elapsed={hr_ms(elapsed)}  error={err[:120]}")
    if raw:
        print(f"  raw length={len(raw)} chars")
    return ok, elapsed


def test_tcp_probe(port: int, label: str):
    print(f"\n[TCP PROBE] port {port} ({label})")
    import socket
    t0 = time.monotonic()
    try:
        s = socket.create_connection((HOST, port), timeout=3.0)
        elapsed = int((time.monotonic() - t0) * 1000)
        s.close()
        print(f"  OPEN  elapsed={hr_ms(elapsed)}")
        return True
    except Exception as exc:
        elapsed = int((time.monotonic() - t0) * 1000)
        print(f"  CLOSED/FILTERED  elapsed={hr_ms(elapsed)}  error={exc}")
        return False


if __name__ == "__main__":
    print("=" * 60)
    print("JUNIPER PERFORMANCE TEST — 10.10.20.102")
    print(f"Credentials: {USER}/{'*'*len(PASS)}")
    print("=" * 60)

    # TCP probes
    test_tcp_probe(22, "SSH")
    test_tcp_probe(830, "NETCONF SSH")
    test_tcp_probe(8443, "RESTCONF")

    results = {}

    # NETCONF tests
    nc_uptime_ok, nc_uptime_ms = test_netconf_uptime()
    results["NETCONF uptime"] = (nc_uptime_ok, nc_uptime_ms)

    nc_iface_ok, nc_iface_ms = test_netconf_interface()
    results["NETCONF interface"] = (nc_iface_ok, nc_iface_ms)

    nc_full_ok, nc_full_ms = test_netconf_full_config()
    results["NETCONF full config"] = (nc_full_ok, nc_full_ms)

    # RESTCONF tests
    rest_uptime_ok, rest_uptime_ms = test_restconf_uptime()
    results["RESTCONF uptime"] = (rest_uptime_ok, rest_uptime_ms)

    rest_cfg_ok, rest_cfg_ms = test_restconf_config()
    results["RESTCONF config"] = (rest_cfg_ok, rest_cfg_ms)

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    for name, (ok, ms) in results.items():
        status = "✅" if ok else "❌"
        print(f"  {status} {name}: {hr_ms(ms)}")
