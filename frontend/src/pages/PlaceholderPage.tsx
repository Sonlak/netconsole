import { Button, Typography } from 'antd';
import type { ReactNode } from 'react';

type PlaceholderPageProps = {
  title: string;
  description: string;
  icon: ReactNode;
  actionLabel?: string;
};

export default function PlaceholderPage({
  title,
  description,
  icon,
  actionLabel = 'Coming soon',
}: PlaceholderPageProps) {
  return (
    <div className="nc-page-shell">
      <div className="nc-empty-page">
        <div className="nc-empty-icon">{icon}</div>
        <Typography.Title level={3} style={{ marginBottom: 8 }}>
          {title}
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ maxWidth: 460, marginBottom: 24 }}>
          {description}
        </Typography.Paragraph>
        <Button type="primary" size="large">
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
