import type { CSSProperties } from 'react';
import { Typography } from 'antd';

export function MonoValue({
  value,
  copyable = false,
  className,
  style,
}: {
  value: string;
  copyable?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Typography.Text
      className={className}
      copyable={copyable ? { text: value, tooltips: ['Copy', 'Copied'] } : false}
      style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', fontSize: 12, fontVariantNumeric: 'tabular-nums', ...style }}
    >
      {value || '—'}
    </Typography.Text>
  );
}

export function IpAddress({ value, copyable = true }: { value: string; copyable?: boolean }) {
  return <MonoValue value={value} copyable={copyable} className="nc-ip-cell" />;
}

export function MacAddress({ value, copyable = true }: { value: string; copyable?: boolean }) {
  return <MonoValue value={value} copyable={copyable} />;
}
