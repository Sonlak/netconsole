import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Result, Space, Typography } from 'antd';

type Props = { children: ReactNode };
type State = { hasError: boolean; error: Error | null };

const CHUNK_RELOAD_KEY = 'nc-chunk-reload';

function isChunkLoadError(error: Error | null) {
  const text = `${error?.name ?? ''} ${error?.message ?? ''}`;
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk/i.test(
    text,
  );
}

function reloadOnceForChunkError() {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1') return false;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary', error, errorInfo);
    if (isChunkLoadError(error)) {
      reloadOnceForChunkError();
    }
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const chunkError = isChunkLoadError(this.state.error);
      return (
        <Result
          status="error"
          title={chunkError ? 'Failed to load this page' : 'This page crashed'}
          subTitle={
            chunkError
              ? 'A new version may have been deployed. Reload to pick up the latest assets.'
              : this.state.error?.message || 'An unexpected render error stopped this view.'
          }
          extra={
            <Space>
              <Button onClick={this.reset}>Try again</Button>
              <Button type="primary" onClick={() => window.location.reload()}>
                Reload
              </Button>
            </Space>
          }
        >
          {this.state.error?.stack && !chunkError ? (
            <Typography.Paragraph type="secondary" style={{ maxWidth: 640, margin: '0 auto', textAlign: 'left' }}>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{this.state.error.message}</pre>
            </Typography.Paragraph>
          ) : null}
        </Result>
      );
    }
    return this.props.children;
  }
}
