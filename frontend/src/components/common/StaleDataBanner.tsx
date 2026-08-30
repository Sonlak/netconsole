import { Alert, Button } from 'antd';
import { Timestamp } from '@/components/display/Timestamp';
import { errorMessage } from '@/lib/errors';

export function StaleDataBanner({
  error,
  onRetry,
}: {
  error: Error | null;
  onRetry?: () => void;
}) {
  if (!error) return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message="Refresh failed — showing last successful data"
      description={errorMessage(error)}
      action={
        onRetry ? (
          <Button size="small" onClick={onRetry}>
            Retry
          </Button>
        ) : null
      }
    />
  );
}

export function RefreshIndicator({
  refreshing,
  lastUpdatedAt,
}: {
  refreshing?: boolean;
  lastUpdatedAt?: string | null;
}) {
  if (refreshing) return <span className="nc-refresh">Refreshing…</span>;
  if (!lastUpdatedAt) return null;
  return (
    <span className="nc-refresh">
      Updated <Timestamp value={lastUpdatedAt} />
    </span>
  );
}
