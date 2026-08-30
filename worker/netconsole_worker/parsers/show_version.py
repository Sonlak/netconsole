import re
from typing import Any


def parse_cisco_show_version(output: str) -> dict[str, str]:
    parsed: dict[str, str] = {"vendor": "Cisco"}

    hostname_match = re.search(r"^(\S+)\s+uptime is ", output, re.MULTILINE)
    if hostname_match:
        parsed["hostname"] = hostname_match.group(1)

    version_match = re.search(r"Version\s+([^\s,]+)", output)
    if version_match:
        parsed["version"] = version_match.group(1)

    model_match = re.search(r"Model Number\s+:\s+(\S+)", output)
    if not model_match:
        model_match = re.search(r"cisco\s+(\S+)\s+processor", output, re.IGNORECASE)
    if model_match:
        parsed["model"] = model_match.group(1)

    serial_match = re.search(
        r"(?:Processor board ID|System serial number)\s+(\S+)",
        output,
        re.IGNORECASE,
    )
    if serial_match:
        parsed["serial"] = serial_match.group(1)

    return parsed


def parse_juniper_show_version(output: str) -> dict[str, str]:
    parsed: dict[str, str] = {"vendor": "Juniper"}

    hostname_match = re.search(r"^Hostname:\s*(\S+)", output, re.MULTILINE)
    if hostname_match:
        parsed["hostname"] = hostname_match.group(1)

    model_match = re.search(r"^Model:\s*(\S+)", output, re.MULTILINE)
    if model_match:
        parsed["model"] = model_match.group(1)

    version_match = re.search(r"JUNOS Software Release \[([^\]]+)\]", output)
    if version_match:
        parsed["version"] = version_match.group(1)

    serial_match = re.search(r"Serial number:\s*(\S+)", output, re.IGNORECASE)
    if serial_match:
        parsed["serial"] = serial_match.group(1)

    return parsed


def parse_show_version(vendor: str, output: str) -> dict[str, Any]:
    vendor_key = vendor.lower()
    output_lower = output.lower()

    if "juniper" in vendor_key or "junos" in output_lower or "hostname:" in output_lower:
        return parse_juniper_show_version(output)

    if "cisco" in vendor_key or "ios" in output_lower:
        return parse_cisco_show_version(output)

    return {"vendor": vendor or "Unknown"}
