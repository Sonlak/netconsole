/**
 * Confirmation card for a WRITE tool call.
 *
 * Subtle, low-noise warning style — matches the production AI
 * assistant convention of "this action needs you to OK it" rather
 * than the old aggressive yellow border. Accent strip on the left
 * signals the caution level without painting the whole card.
 */

import { Button, Space, Typography, theme } from 'antd';
import { CheckOutlined, CloseOutlined, WarningFilled } from '@ant-design/icons';
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
  const { token } = theme.useToken();
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
    <div
      style={{
        // Subtle warning card: tinted bg + 1px warning-tinted border
        // + a 3px left accent strip. No harsh yellow surface.
        background: token.colorWarningBg,
        border: `1px solid ${token.colorWarningBorder}`,
        borderLeft: `3px solid ${token.colorWarning}`,
        borderRadius: 10,
        padding: 12,
      }}
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space size={6}>
          <WarningFilled style={{ color: token.colorWarning, fontSize: 14 }} />
          <Typography.Text strong style={{ fontSize: 13 }}>
            {TOOL_LABELS[name] ?? 'Yêu cầu xác nhận'}
          </Typography.Text>
        </Space>

        <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>{summary}</div>

        <details>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 11,
              color: token.colorTextTertiary,
              userSelect: 'none',
            }}
          >
            Xem tham số
          </summary>
          <pre
            style={{
              fontSize: 11,
              background: token.colorFillTertiary,
              padding: 8,
              borderRadius: 6,
              margin: '6px 0 0',
              maxHeight: 200,
              overflow: 'auto',
              border: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            {JSON.stringify(args, null, 2)}
          </pre>
        </details>

        <Space size={6} style={{ marginTop: 2 }}>
          <Button
            danger
            type="primary"
            icon={<CheckOutlined />}
            loading={busy}
            onClick={handleConfirm}
            size="small"
          >
            Xác nhận
          </Button>
          <Button
            icon={<CloseOutlined />}
            disabled={busy}
            onClick={onCancel}
            size="small"
          >
            Huỷ
          </Button>
        </Space>
      </Space>
    </div>
  );
}
