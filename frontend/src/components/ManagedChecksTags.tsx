import { Space, Tag, Typography } from 'antd';
import { MANAGED_CHECK_LABELS, type ManagedChecks } from '@/types/device';

export default function ManagedChecksTags({ checks }: { checks: ManagedChecks | null | undefined }) {
  if (!checks) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Unchecked
      </Typography.Text>
    );
  }

  return (
    <Space size={4} wrap>
      {MANAGED_CHECK_LABELS.map(({ key, label }) => (
        <Tag key={key} color={checks[key] ? 'success' : 'error'}>
          {label}
        </Tag>
      ))}
    </Space>
  );
}
