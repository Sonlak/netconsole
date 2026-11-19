/**
 * Tests for the Cisco IOS / IOS-XE identity parsers.
 *
 * Context (2026-11-19): a real Catalyst C9200 (NTMK-AS-T02-01-C9200,
 * 10.1.250.21, IOS-XE 17.3.5) was discovered on production but came back
 * with `model = "Unknown"` even though the device printed its model
 * plainly:
 *
 *   Model Number                       : C9200L-48T-4X
 *
 * Two root causes, both covered here:
 *
 *   1. `parseIosShowVersion` had no rule for the `Model Number :` line.
 *      The old banner regex (" <MODEL> Software ( ... ) ") matches IOS
 *      12/15 but NOT IOS-XE 17.x, whose banner reads
 *      "Cisco IOS Software [Amsterdam], Catalyst L3 Switch Software
 *       (CAT9K_LITE_IOSXE), Version 17.3.5, ...".
 *
 *   2. The IOS "IOSexec" HTTP probe used a plain GET, which on IOS-XE 17
 *      returns only the menu page (no CLI output at all) — so the probe
 *      reported success with an empty identity.
 */
import { describe, it, expect } from 'vitest';
import { parseIosShowVersion } from '../../src/services/labSsh.js';

/**
 * Real `show version` output captured from NTMK-AS-T02-01-C9200
 * (Catalyst C9200L-48T-4X, IOS-XE 17.3.5) on 2026-11-19.
 */
const C9200_SHOW_VERSION = `Cisco IOS XE Software, Version 17.03.05
Cisco IOS Software [Amsterdam], Catalyst L3 Switch Software (CAT9K_LITE_IOSXE), Version 17.3.5, RELEASE SOFTWARE (fc2)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2022 by Cisco Systems, Inc.
Compiled Wed 09-Feb-22 09:28 by mcpre

Cisco IOS-XE software, Copyright (c) 2005-2022 by cisco Systems, Inc.
All rights reserved.

ROM: IOS-XE ROMMON
BOOTLDR: System Bootstrap, Version 17.9.1r [FC6], RELEASE SOFTWARE (P)

NTMK-AS-T02-01-C9200 uptime is 5 days, 55 minutes
Uptime for this control processor is 5 days, 57 minutes
System returned to ROM by Power Failure or Unknown
System restarted at 14:25:59 GMT Sat Nov 14 2026
System image file is "flash:packages.conf"
Last reload reason: Power Failure or Unknown

cisco C9200L-48T-4X (ARM64) processor with 523625K/3071K bytes of memory.
Processor board ID JAE26300PKR
3 Virtual Ethernet interfaces
48 Gigabit Ethernet interfaces
4 Ten Gigabit Ethernet interfaces
2048K bytes of non-volatile configuration memory.

Base Ethernet MAC Address          : 3c:26:e4:5d:dd:80
Motherboard Assembly Number        : 73-102066-04
Motherboard Serial Number          : JAE26300PKR
Model Revision Number              : D0
Motherboard Revision Number        : A0
Model Number                       : C9200L-48T-4X
System Serial Number               : JAE26300PKR
CLEI Code Number                   : INM6H00ARB

Switch Ports Model              SW Version        SW Image              Mode
------ ----- -----              ----------        ----------            ----
*    1 52    C9200L-48T-4X      17.03.05          CAT9K_LITE_IOSXE      INSTALL

Configuration register is 0x102`;

/**
 * Real `show version` output from an IOS 15.2 vios_l2 image
 * (LAB-F3-AS-01 / 10.10.20.211) — the shape the parser was originally
 * written for. Kept here to guard against regressions.
 */
const IOSV_SHOW_VERSION = `Cisco IOS Software, vios_l2 Software (vios_l2-ADVENTERPRISEK9-M), Version 15.2(4)E7, RELEASE SOFTWARE (fc3)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2018 by Cisco Systems, Inc.
Compiled Wed 21-Mar-18 11:22 by mcpre

ROM: Bootstrap program is IOSv
LAB-F3-AS-01 uptime is 1 hour, 6 minutes
System returned to ROM by reload
System image file is "flash0:/vios_l2-adventerprisek9-m"
`;

/**
 * Real `show version` output from a physical IOS router (ISR4331).
 * The banner carries the model in the "<MODEL> Software ( ... )" shape.
 */
const ISR4331_SHOW_VERSION = `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.7(3)M5, RELEASE SOFTWARE (fc1)
Copyright (c) 1986-2016 by Cisco Systems, Inc.
Compiled Wed 30-Mar-16 07:12 by prod_rel_team

ROM: Bootstrap program is cisco ISR4331/K9
Router uptime is 3 days, 4 hours, 21 minutes
System returned to ROM by power-on
System image file is "flash0:cisco1k-universalk9-mz.SPA.157-3.M5.bin"
Processor board ID FTX1512AHK2
`;
const ISR4331_HOSTNAME = 'Router';

describe('parseIosShowVersion — IOS-XE 17.x Catalyst (C9200)', () => {
  it('extracts the model from the "Model Number :" hardware line', () => {
    // Regression test for the production bug: model came back "Unknown"
    // because IOS-XE 17.x does not use the "<MODEL> Software ( ... )"
    // banner shape.
    const parsed = parseIosShowVersion(C9200_SHOW_VERSION);
    expect(parsed.model).toBe('C9200L-48T-4X');
  });

  it('prefers "Model Number" over the bogus CAT9K_LITE_IOSXE banner token', () => {
    // The banner contains "Catalyst L3 Switch Software (CAT9K_LITE_IOSXE)"
    // — a software-train name, NOT the hardware model. The parser must
    // not latch onto it.
    const parsed = parseIosShowVersion(C9200_SHOW_VERSION);
    expect(parsed.model).not.toBe('CAT9K_LITE_IOSXE');
    expect(parsed.model).not.toBe('Catalyst');
  });

  it('extracts hostname, version and serial', () => {
    const parsed = parseIosShowVersion(C9200_SHOW_VERSION);
    expect(parsed.hostname).toBe('NTMK-AS-T02-01-C9200');
    expect(parsed.version).toBe('17.03.05');
    expect(parsed.serial).toBe('JAE26300PKR');
    expect(parsed.vendor).toBe('Cisco');
  });

  it('does not treat the ROM bootstrap line as a model', () => {
    // IOS-XE has "ROM: IOS-XE ROMMON" — no "Bootstrap program is" line,
    // so there is no IOSv-style fallback to accidentally pick up.
    const parsed = parseIosShowVersion(C9200_SHOW_VERSION);
    expect(parsed.model).not.toBe('IOS-XE');
    expect(parsed.model).not.toBe('ROMMON');
  });
});

describe('parseIosShowVersion — IOS 15.x / IOSv regression', () => {
  it('still extracts the model from "Bootstrap program is IOSv"', () => {
    const parsed = parseIosShowVersion(IOSV_SHOW_VERSION);
    expect(parsed.model).toBe('IOSv');
    expect(parsed.hostname).toBe('LAB-F3-AS-01');
  });

  it('still extracts the model from a physical-router banner', () => {
    const parsed = parseIosShowVersion(ISR4331_SHOW_VERSION);
    expect(parsed.model).toBe('C2900');
    expect(parsed.serial).toBe('FTX1512AHK2');
  });
});

describe('parseIosShowVersion — edge cases', () => {
  it('returns vendor only for empty input', () => {
    expect(parseIosShowVersion('')).toEqual({ vendor: 'Cisco' });
  });

  it('does not crash on a truncated show version', () => {
    const parsed = parseIosShowVersion('Cisco IOS XE Software, Version 17.03.05\n');
    expect(parsed.vendor).toBe('Cisco');
  });
});
