import { Button, Result } from 'antd';
import { errorMessage } from '@/lib/errors';

export function ErrorState({
  error,
  title = 'Could not load data',
  onRetry,
}: {
  error?: Error | null;
  title?: string;
  onRetry?: () => void;
}) {
  return (
    <Result
      status="error"
      title={title}
      subTitle={errorMessage(error ?? null)}
      extra={
        onRetry ? (
          <Button type="primary" onClick={onRetry}>
            Retry
          </Button>
        ) : null
      }
    />
  );
}
