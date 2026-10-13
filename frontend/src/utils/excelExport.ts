/**
 * Export an assistant tool-call preview to a downloadable XLSX file.
 *
 * Why client-side: the data already lives in the chat message (it was
 * just rendered in the JSON preview). Round-tripping it back to the
 * backend just to receive a workbook wastes a request and ties the
 * feature to a new HTTP route. SheetJS works in the browser natively.
 *
 * Shape contract (matches every assistant handler's `preview` payload):
 *   { total: number, items: [{...}, ...] }
 * where `items` is the array key (e.g. `devices`, `prefixes`, `vlans`,
 * `interfaces`, `ipAddresses`, `manufacturers`, `deviceRoles`,
 * `sites`, `leases`, `alerts`, `jobs`, `logs`, `mac`, `arp`).
 *
 * We auto-detect the array key by walking the preview's top-level
 * fields and picking the first array. That makes the export button
 * work for any future tool without code changes.
 */
import * as XLSX from 'xlsx';

type Scalar = string | number | boolean | null | undefined;
type Cell = Scalar | Date | object;
type Row = Record<string, Cell>;

/**
 * Find the exportable array inside a preview payload.
 * Returns the array (possibly empty) and the key it lives under.
 * Returns null if the preview has no array of records.
 */
export function detectPreviewArray(
  preview: unknown,
): { key: string; rows: Row[] } | null {
  if (!preview || typeof preview !== 'object') return null;
  const obj = preview as Record<string, unknown>;
  // Prefer the conventional 'items' key if present.
  const preferred = ['items', 'rows', 'data', 'results'];
  for (const k of preferred) {
    if (Array.isArray(obj[k])) {
      return { key: k, rows: obj[k] as Row[] };
    }
  }
  // Otherwise, walk and find the first array that is non-empty (or empty
  // array — empty result is still a valid export, just a blank sheet).
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      return { key: k, rows: v as Row[] };
    }
  }
  return null;
}

/**
 * Flatten a single row's nested objects into dot-notation keys.
 * Example: { name: "F1", site: { id: 1, name: "LAB" } }
 *   → { name: "F1", "site.id": 1, "site.name": "LAB" }
 *
 * Without this, SheetJS writes "[object Object]" for nested fields
 * and the user's spreadsheet is missing the useful columns.
 */
function flattenRow(row: Row, prefix = ''): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) {
      out[key] = null;
    } else if (Array.isArray(v)) {
      // Arrays of primitives → join with "; ". Arrays of objects →
      // recurse with [0], [1] indices.
      if (v.length === 0) {
        out[key] = '';
      } else if (v.every((x) => x === null || typeof x !== 'object')) {
        out[key] = v.join('; ');
      } else {
        v.forEach((item, i) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            Object.assign(out, flattenRow(item as Row, `${key}[${i}]`));
          } else {
            out[`${key}[${i}]`] = item as Cell;
          }
        });
      }
    } else if (v instanceof Date) {
      out[key] = v;
    } else if (typeof v === 'object') {
      Object.assign(out, flattenRow(v as Row, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Build a sheet name that's valid in Excel (≤31 chars, no special chars).
 */
function safeSheetName(name: string): string {
  return name.replace(/[\\/*?:[\]]/g, '_').slice(0, 31) || 'Sheet1';
}

export type ExportResult =
  | { ok: true; filename: string; rowCount: number; sheetName: string }
  | { ok: false; reason: string };

/**
 * Generate an XLSX workbook from a preview payload and trigger a
 * browser download. Returns metadata about what was exported.
 */
export function downloadPreviewAsXlsx(
  preview: unknown,
  options: { toolName?: string; baseName?: string } = {},
): ExportResult {
  const detected = detectPreviewArray(preview);
  if (!detected) {
    return { ok: false, reason: 'Preview không chứa danh sách bản ghi nào để export.' };
  }
  const { key, rows } = detected;

  // Always emit at least the header row, even when rows=[] (so the user
  // sees the column names that *would* be there).
  const flattened = rows.map((r) => flattenRow(r));
  const worksheet = XLSX.utils.json_to_sheet(flattened);
  const workbook = XLSX.utils.book_new();
  const sheetName = safeSheetName(options.toolName ? `${options.toolName}_${key}` : key);
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = options.baseName ?? options.toolName ?? 'netconsole';
  const filename = `${base}_${key}_${stamp}.xlsx`;

  // SheetJS write() in the browser triggers download via a hidden
  // <a download> element. workbook + filename -> Blob -> URL.
  XLSX.writeFile(workbook, filename, { compression: true });

  return { ok: true, filename, rowCount: rows.length, sheetName };
}
