import type { ReactNode } from 'react';
import { Button, Empty, Space } from 'antd';

export function EmptyState({
  title,
  description,
  extra,
}: {
  title: string;
  description?: string;
  extra?: ReactNode;
}) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <Space direction="vertical" size={4}>
          <span style={{ fontWeight: 600 }}>{title}</span>
          {description ? <span>{description}</span> : null}
        </Space>
      }
    >
      {extra}
    </Empty>
  );
}

export function FilteredEmptyState({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState
      title="No results for current filters"
      description="Change or clear filters to see inventory again."
      extra={
        <Button onClick={onClear}>Clear filters</Button>
      }
    />
  );
}
