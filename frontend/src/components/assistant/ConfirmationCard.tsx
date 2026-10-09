/**
 * Confirmation card for a WRITE tool call.
 *
 * The backend emits a `confirmation_required` event with the
 * proposed action + a human summary. This component renders the
 * card with [Confirm] and [Cancel] buttons; clicking either fires
 * the corresponding callback. The backend never executes the tool
 * without a confirmedToolCall echo from the client.
 */

import { Button, Card, Space, Typography } from 'antd';
import { ExclamationCircleOutlined, RocketOutlined, StopOutlined } from '@ant-design/icons';
import { useState } from 'react';

type Props = {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  summary: string;
  onConfirm: () => void;
  onCancel: () => void;
};

const TOOL_LABELS: Record<string, string> = {
  queue_interface_action: 'Thay đổi cấu hình interface',
  queue_log_collect: 'Trigger thu thập log',
  queue_managed_check: 'Kiểm tra managed status',
};

export function ConfirmationCard({ name, arguments: args, summary, onConfirm, onCancel }: Props) {
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await Promise.resolve(onConfirm());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      size="small"
      style={{
        borderColor: '#faad14',
        background: 'rgba(250, 173, 20, 0.05)',
      }}
      styles={{ body: { padding: 12 } }}
    >
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Space>
          <ExclamationCircleOutlined style={{ color: '#faad14', fontSize: 16 }} />
          <Typography.Text strong>
            {TOOL_LABELS[name] ?? 'Yêu cầu xác nhận'}
          </Typography.Text>
        </Space>

        <div style={{ fontSize: 14 }}>{summary}</div>

        <details>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: '#888' }}>
            Chi tiết tham số
          </summary>
          <pre
            style={{
              fontSize: 11,
              background: 'rgba(0,0,0,0.04)',
              padding: 6,
              borderRadius: 4,
              margin: '4px 0 0',
              maxHeight: 200,
              overflow: 'auto',
            }}
          >
            {JSON.stringify(args, null, 2)}
          </pre>
        </details>

        <Space size={8} style={{ marginTop: 4 }}>
          <Button
            type="primary"
            danger
            icon={<RocketOutlined />}
            loading={busy}
            onClick={handleConfirm}
          >
            Xác nhận
          </Button>
          <Button icon={<StopOutlined />} disabled={busy} onClick={onCancel}>
            Huỷ
          </Button>
        </Space>
      </Space>
    </Card>
  );
}
