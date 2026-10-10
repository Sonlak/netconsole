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
});
