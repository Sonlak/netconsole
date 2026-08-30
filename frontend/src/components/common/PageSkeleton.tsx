import { Card, Skeleton, Space } from 'antd';

export function PageSkeleton() {
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Skeleton active paragraph={{ rows: 1 }} title={{ width: 220 }} />
      <Card bordered={false}>
        <Skeleton active paragraph={{ rows: 6 }} />
      </Card>
    </Space>
  );
}
