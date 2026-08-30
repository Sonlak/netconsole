import type { ReactNode } from 'react';
import { Card, Flex, Typography } from 'antd';

export function DataTableShell({
  title,
  count,
  countLabel = 'loaded',
  toolbar,
  chips,
  freshness,
  extra,
  children,
}: {
  title: string;
  count: number;
  countLabel?: string;
  toolbar?: ReactNode;
  chips?: ReactNode;
  freshness?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card bordered={false} styles={{ body: { padding: 12 } }}>
      <Flex align="center" justify="space-between" gap={12} wrap style={{ marginBottom: 8 }}>
        <div>
          <Typography.Text strong>{title}</Typography.Text>
          <Typography.Text type="secondary">
            {' '}
            · {count} {countLabel}
          </Typography.Text>
        </div>
        <Flex align="center" gap={8} wrap>
          {freshness}
          {extra}
        </Flex>
      </Flex>
      {toolbar ? <div className="nc-dt-toolbar">{toolbar}</div> : null}
      {chips ? <div className="nc-dt-chips">{chips}</div> : null}
      <div className="nc-dt-table">{children}</div>
    </Card>
  );
}
