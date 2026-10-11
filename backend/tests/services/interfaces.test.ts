import { describe, it, expect } from 'vitest';
import { parseInterfaceActionPayload } from '../../src/services/interfaces.js';

describe('parseInterfaceActionPayload', () => {
  // ── Legacy single-action form (backward compat) ──────────────────────────

  it('accepts legacy shut action', () => {
    const out = parseInterfaceActionPayload({
      action: 'shut',
      interface: 'ge-0/0/5',
    });
    expect(out).toEqual({ action: 'shut', interface: 'ge-0/0/5' });
  });

  it('accepts legacy set-access-vlan with vlan', () => {
    const out = parseInterfaceActionPayload({
      action: 'set-access-vlan',
      interface: 'ge-0/0/3',
      vlan: '100',
    });
    expect(out).toEqual({ action: 'set-access-vlan', interface: 'ge-0/0/3', vlan: '100' });
  });

  it('rejects set-access-vlan without vlan', () => {
    const out = parseInterfaceActionPayload({
      action: 'set-access-vlan',
      interface: 'ge-0/0/3',
    });
    expect(out).toBeNull();
  });

  it('rejects out-of-range vlan', () => {
    expect(parseInterfaceActionPayload({ action: 'set-access-vlan', interface: 'x', vlan: '5000' })).toBeNull();
    expect(parseInterfaceActionPayload({ action: 'set-access-vlan', interface: 'x', vlan: '0' })).toBeNull();
  });

  it('accepts legacy set-description with non-empty description', () => {
    const out = parseInterfaceActionPayload({
      action: 'set-description',
      interface: 'ge-0/0/3',
      description: 'uplink-to-core',
    });
    expect(out).toEqual({ action: 'set-description', interface: 'ge-0/0/3', description: 'uplink-to-core' });
  });

  it('accepts legacy delete-interface', () => {
    const out = parseInterfaceActionPayload({
      action: 'delete-interface',
      interface: 'xe-0/0/7',
    });
    expect(out).toEqual({ action: 'delete-interface', interface: 'xe-0/0/7' });
  });

  it('rejects unknown action', () => {
    expect(parseInterfaceActionPayload({ action: 'totally-bogus', interface: 'x' })).toBeNull();
  });

  it('rejects missing interface', () => {
    expect(parseInterfaceActionPayload({ action: 'shut' })).toBeNull();
  });

  // ── New multi-action form ────────────────────────────────────────────────

  it('accepts multi-action with one subaction', () => {
    const out = parseInterfaceActionPayload({
      interface: 'xe-0/0/7',
      actions: [{ action: 'shut' }],
    });
    expect(out).toEqual({ interface: 'xe-0/0/7', actions: [{ action: 'shut' }] });
  });

  it('accepts the canonical "set vlan + set description" batch', () => {
    const out = parseInterfaceActionPayload({
      interface: 'xe-0/0/7',
      actions: [
        { action: 'set-access-vlan', vlan: '203' },
        { action: 'set-description', description: 'sonnx_test' },
      ],
    });
    expect(out).toEqual({
      interface: 'xe-0/0/7',
      actions: [
        { action: 'set-access-vlan', vlan: '203' },
        { action: 'set-description', description: 'sonnx_test' },
      ],
    });
  });

  it('accepts multi-action with up to 16 subactions', () => {
    const subs = Array.from({ length: 16 }, () => ({ action: 'shut' as const }));
    const out = parseInterfaceActionPayload({ interface: 'xe-0/0/7', actions: subs });
    expect(out?.actions).toHaveLength(16);
  });

  it('rejects multi-action with more than 16 subactions', () => {
    const subs = Array.from({ length: 17 }, () => ({ action: 'shut' as const }));
    const out = parseInterfaceActionPayload({ interface: 'xe-0/0/7', actions: subs });
    expect(out).toBeNull();
  });

  it('rejects empty multi-action array', () => {
    const out = parseInterfaceActionPayload({ interface: 'xe-0/0/7', actions: [] });
    expect(out).toBeNull();
  });

  it('rejects multi-action with invalid subaction action', () => {
    const out = parseInterfaceActionPayload({
      interface: 'xe-0/0/7',
      actions: [{ action: 'totally-bogus' }],
    });
    expect(out).toBeNull();
  });

  it('rejects multi-action with subaction missing required field', () => {
    expect(parseInterfaceActionPayload({
      interface: 'xe-0/0/7',
      actions: [{ action: 'set-access-vlan' }], // no vlan
    })).toBeNull();

    expect(parseInterfaceActionPayload({
      interface: 'xe-0/0/7',
      actions: [{ action: 'set-description' }], // no description
    })).toBeNull();

    expect(parseInterfaceActionPayload({
      interface: 'xe-0/0/7',
      actions: [{ action: 'set-description', description: '' }], // empty description
    })).toBeNull();
  });

  it('trims whitespace in vlan and description', () => {
    const out = parseInterfaceActionPayload({
      interface: 'xe-0/0/7',
      actions: [
        { action: 'set-access-vlan', vlan: '  203  ' },
        { action: 'set-description', description: '  sonnx_test  ' },
      ],
    });
    expect(out?.actions?.[0]).toEqual({ action: 'set-access-vlan', vlan: '203' });
    expect(out?.actions?.[1]).toEqual({ action: 'set-description', description: 'sonnx_test' });
  });

  it('rejects non-object body', () => {
    expect(parseInterfaceActionPayload(null)).toBeNull();
    expect(parseInterfaceActionPayload(undefined)).toBeNull();
    expect(parseInterfaceActionPayload('not an object')).toBeNull();
    expect(parseInterfaceActionPayload(42)).toBeNull();
  });

  it('prefers multi-action when both forms are present', () => {
    // If both `action` and `actions` are passed, the multi-action array
    // takes precedence (so the LLM can safely add a legacy `action` for
    // backwards compat without breaking new behavior).
    const out = parseInterfaceActionPayload({
      interface: 'xe-0/0/7',
      action: 'shut',
      actions: [{ action: 'set-access-vlan', vlan: '203' }],
    });
    expect(out?.actions).toBeDefined();
    expect(out?.actions).toHaveLength(1);
  });

  // ── Cross-interface multi-action (NEW) ────────────────────────────────

  it('accepts cross-interface batch: delete + set vlan + desc on 2 ports', () => {
    const out = parseInterfaceActionPayload({
      actions: [
        { interface: 'xe-0/0/8', action: 'delete-interface' },
        { interface: 'xe-0/0/9', action: 'delete-interface' },
        { interface: 'xe-0/0/8', action: 'set-access-vlan', vlan: '201' },
        { interface: 'xe-0/0/8', action: 'set-description', description: 'client-tang1' },
        { interface: 'xe-0/0/9', action: 'set-access-vlan', vlan: '202' },
        { interface: 'xe-0/0/9', action: 'set-description', description: 'client-tang2' },
      ],
    });
    expect(out).toBeTruthy();
    expect(out?.interface).toBeUndefined(); // no top-level
    expect(out?.actions).toHaveLength(6);
    expect(out?.actions?.[0]).toEqual({ action: 'delete-interface', interface: 'xe-0/0/8' });
    expect(out?.actions?.[2]).toEqual({ action: 'set-access-vlan', vlan: '201', interface: 'xe-0/0/8' });
    expect(out?.actions?.[3]).toEqual({ action: 'set-description', description: 'client-tang1', interface: 'xe-0/0/8' });
    expect(out?.actions?.[4]).toEqual({ action: 'set-access-vlan', vlan: '202', interface: 'xe-0/0/9' });
    expect(out?.actions?.[5]).toEqual({ action: 'set-description', description: 'client-tang2', interface: 'xe-0/0/9' });
  });

  it('cross-interface: each subaction must have an interface (no top-level fallback)', () => {
    // The cross-interface shape has NO top-level interface. Every
    // subaction must declare its own. Otherwise the worker would
    // have to guess and that's a footgun.
    const out = parseInterfaceActionPayload({
      actions: [{ action: 'shut' }], // no interface anywhere
    });
    expect(out).toBeTruthy(); // parser still produces a payload; worker will reject at runtime
    // The worker rejects this — verified separately in worker tests.
  });

  it('cross-interface: top-level interface is OPTIONAL when subactions declare their own', () => {
    const out = parseInterfaceActionPayload({
      interface: 'xe-0/0/8', // hoisted but unused because every subaction has its own
      actions: [
        { interface: 'xe-0/0/9', action: 'shut' },
      ],
    });
    expect(out?.actions?.[0]).toEqual({ action: 'shut', interface: 'xe-0/0/9' });
  });

  it('cross-interface: mixed (some subactions have interface, some use top-level)', () => {
    const out = parseInterfaceActionPayload({
      interface: 'xe-0/0/7', // default for subactions without their own
      actions: [
        { action: 'set-access-vlan', vlan: '203' }, // uses top-level
        { interface: 'xe-0/0/8', action: 'set-access-vlan', vlan: '201' }, // overrides
      ],
    });
    expect(out?.actions?.[0]).toEqual({ action: 'set-access-vlan', vlan: '203' });
    expect(out?.actions?.[1]).toEqual({ action: 'set-access-vlan', vlan: '201', interface: 'xe-0/0/8' });
  });

  it('rejects multi-action with 17 subactions (over cap)', () => {
    const subs = Array.from({ length: 17 }, () => ({ action: 'shut' as const }));
    expect(parseInterfaceActionPayload({ actions: subs })).toBeNull();
  });
});
