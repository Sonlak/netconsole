import { App, ConfigProvider, notification } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';
import { useTheme } from '@/components/theme-provider';
import { getAntdTheme } from '@/theme/antd-theme';

/**
 * Mounts inside <App> so App.useApp() works for notification/message.
 * Sets global notification closeIcon so every toast has a manual Close
 * button the user can click to dismiss instead of waiting for auto-close.
 */
function NotificationSetup() {
  useEffect(() => {
    // Add a manual close button (×) to every notification so the user can
    // dismiss it themselves. The standalone notification.config() from 'antd'
    // applies globally regardless of App context.
    notification.config({
      closeIcon: <CloseOutlined />,
      placement: 'topRight',
    });
  }, []);

  return null;
}

export function AntdBridge({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const antdThemeConfig = useMemo(() => getAntdTheme(isDark), [isDark]);

  return (
    <ConfigProvider theme={antdThemeConfig} variant="outlined">
      <App style={{ height: '100%', width: '100%' }}>
        <NotificationSetup />
        {children}
      </App>
    </ConfigProvider>
  );
}
