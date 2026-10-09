/**
 * Lightweight markdown renderer for assistant text.
 *
 * We don't need full GFM — just headings, lists, bold/italic, inline
 * code, code fences, and tables (very common for tool results). We
 * keep a hand-rolled renderer to avoid pulling in another dep
 * (`react-markdown` is ~80 KB gzipped) and to guarantee the same
 * output whether we're streaming tokens or rendering the final text.
 */

import { Typography } from 'antd';

type Props = { content: string };

export function MarkdownText({ content }: Props) {
  const blocks = parseBlocks(content);
  return (
    <div style={{ fontSize: 14, lineHeight: 1.6 }}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}

type Block =
  | { kind: 'h'; level: 1 | 2 | 3; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'pre'; lang?: string; code: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'hr' };

function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Heading
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      out.push({ kind: 'h', level: h[1].length as 1 | 2 | 3, text: h[2] });
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      out.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // Code fence
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || undefined;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      out.push({ kind: 'pre', lang, code: codeLines.join('\n') });
      continue;
    }

    // Table: a header line with pipes, a separator line with dashes+colons,
    // then data lines.
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:|\s]+\|?\s*$/.test(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      out.push({ kind: 'table', header, rows });
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      out.push({ kind: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      out.push({ kind: 'ol', items });
      continue;
    }

    // Default paragraph: collect until blank line.
    const buf: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|---\s*$|```|.*\|.*$|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push({ kind: 'p', text: buf.join(' ') });
  }
  return out;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.replace(/^\s*\|?\s*/, '').replace(/\s*\|?\s*$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function Block({ block }: { block: Block }) {
  switch (block.kind) {
    case 'h': {
      const sizes = { 1: 22, 2: 18, 3: 16 } as const;
      return (
        <div style={{ fontWeight: 600, fontSize: sizes[block.level], margin: '8px 0 4px' }}>
          <Inline text={block.text} />
        </div>
      );
    }
    case 'p':
      return (
        <p style={{ margin: '4px 0' }}>
          <Inline text={block.text} />
        </p>
      );
    case 'ul':
      return (
        <ul style={{ margin: '4px 0 4px 18px' }}>
          {block.items.map((it, i) => (
            <li key={i}>
              <Inline text={it} />
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol style={{ margin: '4px 0 4px 18px' }}>
          {block.items.map((it, i) => (
            <li key={i}>
              <Inline text={it} />
            </li>
          ))}
        </ol>
      );
    case 'pre':
      return (
        <pre
          style={{
            background: 'var(--ant-color-fill-tertiary, rgba(0,0,0,0.04))',
            padding: 8,
            borderRadius: 6,
            overflow: 'auto',
            fontSize: 12,
            margin: '6px 0',
            border: '1px solid var(--ant-color-border-secondary, rgba(0,0,0,0.06))',
          }}
        >
          <code>{block.code}</code>
        </pre>
      );
    case 'table':
      return (
        <div style={{ overflowX: 'auto', margin: '6px 0' }}>
          <table
            style={{
              borderCollapse: 'collapse',
              fontSize: 13,
              width: '100%',
            }}
          >
            <thead>
              <tr>
                {block.header.map((h, i) => (
                  <th
                    key={i}
                    style={{
                      border: '1px solid var(--ant-color-border-secondary, #d9d9d9)',
                      padding: '4px 8px',
                      background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.02))',
                      textAlign: 'left',
                    }}
                  >
                    <Inline text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td
                      key={i}
                      style={{ border: '1px solid var(--ant-color-border-secondary, #d9d9d9)', padding: '4px 8px' }}
                    >
                      <Inline text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr style={{ border: 0, borderTop: '1px solid var(--ant-color-border-secondary, #e8e8e8)', margin: '8px 0' }} />;
  }
}

/** Inline: bold, italic, inline code, links. */
function Inline({ text }: { text: string }) {
  // Tokenise inline: code (`...`), bold (**...**), italic (*...*), link [text](url)
  const parts: Array<{ kind: 'text' | 'code' | 'bold' | 'italic' | 'link'; value: string; href?: string }> = [];
  let i = 0;
  while (i < text.length) {
    // Inline code: `...`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        parts.push({ kind: 'code', value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Bold: **...**
    if (text[i] === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end > i) {
        parts.push({ kind: 'bold', value: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // Link: [text](url)
    if (text[i] === '[') {
      const close = text.indexOf(']', i + 1);
      if (close > i && text[close + 1] === '(') {
        const end = text.indexOf(')', close + 2);
        if (end > close) {
          parts.push({ kind: 'link', value: text.slice(i + 1, close), href: text.slice(close + 2, end) });
          i = end + 1;
          continue;
        }
      }
    }
    // Plain text up to the next special char.
    let j = i + 1;
    while (j < text.length && !['`', '*', '['].includes(text[j])) j += 1;
    parts.push({ kind: 'text', value: text.slice(i, j) });
    i = j;
  }
  return (
    <>
      {parts.map((p, idx) => {
        switch (p.kind) {
          case 'code':
            return (
              <code
                key={idx}
                style={{
                  background: 'var(--ant-color-fill-tertiary, rgba(0,0,0,0.05))',
                  padding: '1px 5px',
                  borderRadius: 3,
                  fontSize: '0.92em',
                }}
              >
                {p.value}
              </code>
            );
          case 'bold':
            return <strong key={idx}>{p.value}</strong>;
          case 'italic':
            return <em key={idx}>{p.value}</em>;
          case 'link':
            return (
              <Typography.Link key={idx} href={p.href} target="_blank" rel="noopener">
                {p.value}
              </Typography.Link>
            );
          default:
            return <span key={idx}>{p.value}</span>;
        }
      })}
    </>
  );
}
