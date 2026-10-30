"""Offline check of the Junos DHCP local server simulator (lab/juniper-sim).

Run:  python lab/scripts/test-dhcp-sim.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "juniper-sim"))

import dhcp_server  # noqa: E402

CONFIG = """
set system services dhcp-local-server group NETCONSOLE-DHCP interface irb.201
set system services dhcp-local-server group NETCONSOLE-DHCP interface irb.202
set access address-assignment pool V201 family inet network 10.1.201.0/24
set access address-assignment pool V201 family inet range V201R low 10.1.201.10 high 10.1.201.254
set access address-assignment pool V201 family inet dhcp-attributes router 10.1.201.254
set access address-assignment pool V201 family inet dhcp-attributes name-server 10.10.20.20
set access address-assignment pool V201 family inet dhcp-attributes maximum-lease-time 28800
set access address-assignment pool V201 family inet host vpc5 hardware-address aa:bb:cc:dd:ee:ff ip-address 10.1.201.50
set access address-assignment pool V202 family inet network 10.1.202.0/24
set access address-assignment pool V202 family inet range V202R low 10.1.202.10 high 10.1.202.254
set access address-assignment pool V202 family inet dhcp-attributes router 10.1.202.254
set access address-assignment pool V202 family inet dhcp-attributes name-server 10.10.20.20
set access address-assignment pool V202 family inet dhcp-attributes maximum-lease-time 28800
"""


def main() -> int:
    tmp = tempfile.mkdtemp()
    running = os.path.join(tmp, "running.set")
    with open(running, "w", encoding="utf-8") as handle:
        handle.write(CONFIG)

    dhcp_server.RUNNING_PATH = running
    dhcp_server.STATE_DIR = tmp
    dhcp_server.CONF_PATH = os.path.join(tmp, "dnsmasq.conf")
    dhcp_server.LEASE_PATH = os.path.join(tmp, "dnsmasq.leases")
    dhcp_server.PID_PATH = os.path.join(tmp, "dnsmasq.pid")

    pools = dhcp_server.parse_pools(CONFIG)
    assert len(pools) == 2, pools
    assert pools[0]["name"] == "V201"
    assert pools[0]["network"] == "10.1.201.0/24"
    assert pools[0]["low"] == "10.1.201.10"
    assert pools[0]["high"] == "10.1.201.254"
    assert pools[0]["router"] == "10.1.201.254"
    assert pools[0]["dnsServers"] == ["10.10.20.20"]
    assert pools[0]["leaseTime"] == 28800
    assert pools[0]["interface"] == "irb.201", pools[0]
    assert pools[1]["interface"] == "irb.202", pools[1]
    assert pools[0]["hosts"] == [
        {"name": "vpc5", "mac": "aa:bb:cc:dd:ee:ff", "ip": "10.1.201.50"}
    ]
    print("parse_pools OK")

    conf = dhcp_server.write_dnsmasq_conf(pools)
    assert "dhcp-range=10.1.201.10,10.1.201.254,255.255.255.0,V201" in conf, conf
    assert "dhcp-option=option:router,10.1.201.254" in conf, conf
    assert "dhcp-host=aa:bb:cc:dd:ee:ff,10.1.201.50,vpc5,28800" in conf, conf
    print("dnsmasq conf OK")

    # Fake a lease and check the Junos-shaped outputs.
    import time

    expiry = int(time.time()) + 3600
    with open(dhcp_server.LEASE_PATH, "w", encoding="utf-8") as handle:
        handle.write(f"{expiry} aa:bb:cc:dd:ee:01 10.1.201.11 vpc5 01:aa:bb:cc:dd:ee:01\n")

    text = dhcp_server.bindings_text()
    assert "Client IP Address:  10.1.201.11" in text, text
    assert "Client Pool Name:             V201" in text, text
    assert "State:" in text and "BOUND" in text, text
    print("bindings_text OK")

    xml = dhcp_server.bindings_xml()
    assert "<allocated-address>10.1.201.11</allocated-address>" in xml, xml
    assert "<pool-name>V201</pool-name>" in xml, xml
    print("bindings_xml OK")

    pools_xml = dhcp_server.pools_xml()
    assert "<name>V201</name>" in pools_xml, pools_xml
    assert "<low>10.1.201.10</low>" in pools_xml, pools_xml
    assert "<hardware-address>aa:bb:cc:dd:ee:ff</hardware-address>" in pools_xml, pools_xml
    print("pools_xml OK")

    # clear a single binding
    assert dhcp_server.clear_binding("10.1.201.11") is True
    assert dhcp_server.read_leases() == []
    assert dhcp_server.clear_binding("10.1.201.11") is False
    print("clear_binding OK")

    # CLI surface
    out = dhcp_server.cli_command("show dhcp server binding detail")
    assert out is not None and "Total number of leases: 0" in out, out
    out = dhcp_server.cli_command("clear dhcp server binding 10.1.201.99")
    assert out is not None and "No binding" in out, out
    out = dhcp_server.cli_command("clear dhcp server binding interface irb.201")
    assert out is not None, out
    assert dhcp_server.cli_command("show version") is None
    print("cli_command OK")

    print("\nALL OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
