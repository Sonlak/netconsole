/**
 * Guard against LLM misrouting: when a user says "cấu hình X cổng Y"
 * the model sometimes picks `queue_interface_action` with
 * `action="set-description"` and a description that LOOKS like a
 * protocol keyword ("passive", "ospf area 20", "bgp neighbor", etc.).
 *
 * The interface `description` field is a free-form text label — it
 * does NOT activate any protocol. If the LLM uses it that way, the
 * user's request silently does nothing (or worse, mislabels the port).
 *
 * This guard rejects the bad call with a clear error pointing at the
 * correct tool (`queue_apply_config` with the vendor CLI set-stanza).
 *
 * Verified 2026-10-13 against gpt-4o-mini reproduction: user asked
 * "cấu hình passive cổng ge-0/0/4", LLM proposed
 * `set-description "passive"`, user cancelled 4× in a row.
 */

const PROTOCOL_KEYWORDS = [
  // routing protocols
  'ospf', 'bgp', 'isis', 'rip', 'eigrp',
  // protocol features
  'passive', 'area ', 'neighbor', 'peer', 'vrf', 'rd ', 'route-target',
  // routing objects
  'route-map', 'prefix-list', 'access-list', 'acl', 'policy',
  // L3 features
  'mtu', 'ip address', 'ip ospf', 'ipv6', 'vlan ', 'vlanid',
  // junos-specific set-stanza fragments
  'protocols ', 'interfaces ge-', 'interfaces xe-', 'interfaces et-',
  'unit 0', 'family inet',
];

export type InterfaceActionPayload = {
  action?: string;
  description?: string;
  interface?: string;
  actions?: Array<{ action?: string; description?: string; interface?: string }>;
};

/**
 * Returns an error string if the call should be rejected, null if OK.
 */
export function checkProtocolKeywordInDescription(
  payload: InterfaceActionPayload,
): string | null {
  const descsToCheck: Array<{ ctx: string; desc: string; original: string }> = [];
  if (payload.action === 'set-description' && typeof payload.description === 'string') {
    descsToCheck.push({ ctx: 'top-level', desc: payload.description.toLowerCase(), original: payload.description });
  }
  if (Array.isArray(payload.actions)) {
    for (const s of payload.actions) {
      if (s.action === 'set-description' && typeof s.description === 'string') {
        descsToCheck.push({ ctx: 'sub-action', desc: s.description.toLowerCase(), original: s.description });
      }
    }
  }
  if (descsToCheck.length === 0) return null;

  for (const { ctx, desc, original } of descsToCheck) {
    for (const kw of PROTOCOL_KEYWORDS) {
      if (desc.includes(kw)) {
        return (
          `Refused: description "${original}" (${ctx}) looks like a protocol/routing ` +
          `keyword ("${kw.trim()}"). The interface description field is a free-form ` +
          `text label — it does NOT enable OSPF/BGP/passive/VLAN/etc. To actually ` +
          `configure routing on a port, use queue_apply_config with the vendor CLI ` +
          `set-stanza, e.g. for Junos: ` +
          `apply_config_dry_run({device_name:"...", mode:"merge", ` +
          `content:"set protocols ospf area 0.0.0.20 interface ge-0/0/4.0 passive"}) ` +
          `then queue_apply_config with the same content.`
        );
      }
    }
  }
  return null;
}
