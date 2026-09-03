/**
 * Named Junos log files we expose to operators.
 *
 * `show log <filename>` can ask Junos for any user-configured log filename.
 * The four below are the canonical ones every Junos deployment ships with:
 *
 *   - messages:                     default syslog stream
 *   - configuration:                config-change events (`facility=change-log`)
 *   - interactive-commands:         CLI commands run by humans
 *   - firewall:                     security module (`facility=firewall`)
 *
 * Free-text filenames are rejected by the UI API so we don't let users
 * accidentally ask for `.*` or `/var/db/...`. If your deployment has a
 * custom log filename, add it to this list — that's the only whitelist.
 */

export type JunosLogFile = {
  filename: string;
  label: string;
  facilityHint: string;
  description: string;
};

export const JUNOS_LOG_FILES: JunosLogFile[] = [
  {
    filename: 'messages',
    label: 'System messages',
    facilityHint: 'daemon',
    description: 'Default syslog stream from mgd / rpd / mib2d / etc.',
  },
  {
    filename: 'configuration',
    label: 'Configuration changes',
    facilityHint: 'change-log',
    description: 'Every `set`/`delete`/`commit` event recorded by mgd.',
  },
  {
    filename: 'interactive-commands',
    label: 'Interactive commands',
    facilityHint: 'interactive-commands',
    description: 'Human-issued CLI commands (often a security audit source).',
  },
  {
    filename: 'firewall',
    label: 'Firewall',
    facilityHint: 'firewall',
    description: 'Security / screen counter hits on the forwarding plane.',
  },
];

export const FILENAME_SET: ReadonlySet<string> = new Set(JUNOS_LOG_FILES.map((file) => file.filename));

export function isAllowedLogFilename(value: string | null | undefined): value is string {
  if (!value) return false;
  return FILENAME_SET.has(value);
}

export function junosLogFile(filename: string): JunosLogFile | undefined {
  return JUNOS_LOG_FILES.find((file) => file.filename === filename);
}
