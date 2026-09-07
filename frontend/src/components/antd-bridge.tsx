import { useEffect } from 'react';
import { App, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTheme } from '@/components/theme-provider';
import { getAntdTheme } from '@/theme/antd-theme';
import { bindJobNotifier } from '@/lib/jobNotifier';

export function AntdBridge({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const antdThemeConfig = useMemo(() => getAntdTheme(isDark), [isDark]);

  return (
    <ConfigProvider theme={antdThemeConfig} variant="outlined">
      <App style={{ height: '100%', width: '100%' }}>
        <JobNotifierHost />
        {children}
      </App>
    </ConfigProvider>
  );
}

/**
 * Lives inside <App> so App.useApp() returns the context-aware
 * notification/message instances. Binds them to the module-level
 * jobNotifier API on mount so background polls (started from anywhere)
 * can fire toasts reliably.
 */
function JobNotifierHost(): null {
  const { notification, message } = App.useApp();
  useEffect(() => {
    bindJobNotifier({ notification, message });
  }, [notification, message]);
  return null;
}
