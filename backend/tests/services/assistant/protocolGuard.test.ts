import { describe, expect, it } from 'vitest';
import { checkProtocolKeywordInDescription } from '../../../src/services/assistant/protocolGuard.js';

describe('checkProtocolKeywordInDescription', () => {
  it('rejects set-description with "passive" (the original bug)', () => {
    const r = checkProtocolKeywordInDescription({
      action: 'set-description',
      interface: 'ge-0/0/4',
      description: 'passive',
    });
    expect(r).toBeTruthy();
    expect(r).toMatch(/queue_apply_config/);
  });

  it('rejects set-description with "ospf area 20"', () => {
    const r = checkProtocolKeywordInDescription({
      action: 'set-description',
      interface: 'ge-0/0/4',
      description: 'ospf area 20',
    });
    expect(r).toBeTruthy();
  });

  it('rejects set-description inside an actions[] subaction', () => {
    const r = checkProtocolKeywordInDescription({
      actions: [
        { action: 'set-description', description: 'ospf passive', interface: 'ge-0/0/4' },
      ],
    });
    expect(r).toBeTruthy();
  });

  it('allows normal description like "uplink to core"', () => {
    const r = checkProtocolKeywordInDescription({
      action: 'set-description',
      interface: 'ge-0/0/0',
      description: 'uplink to core',
    });
    expect(r).toBeNull();
  });

  it('allows set-description with room/port naming like "Phong GD A - port 1"', () => {
    const r = checkProtocolKeywordInDescription({
      action: 'set-description',
      interface: 'xe-0/0/0',
      description: 'Phong GD A - port 1',
    });
    expect(r).toBeNull();
  });

  it('does not block shut / no-shut / set-access-vlan actions', () => {
    expect(checkProtocolKeywordInDescription({ action: 'shut', interface: 'ge-0/0/0' })).toBeNull();
    expect(checkProtocolKeywordInDescription({ action: 'no-shut', interface: 'ge-0/0/0' })).toBeNull();
    expect(
      checkProtocolKeywordInDescription({ action: 'set-access-vlan', interface: 'ge-0/0/0', vlan: '100' }),
    ).toBeNull();
  });

  it('blocks BGP neighbor config', () => {
    const r = checkProtocolKeywordInDescription({
      action: 'set-description',
      interface: 'ge-0/0/0',
      description: 'bgp neighbor 1.1.1.1',
    });
    expect(r).toBeTruthy();
  });

  it('blocks VRF config', () => {
    const r = checkProtocolKeywordInDescription({
      action: 'set-description',
      interface: 'ge-0/0/0',
      description: 'VRF RED',
    });
    expect(r).toBeTruthy();
  });
});
