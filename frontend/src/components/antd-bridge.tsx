import { App, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTheme } from '@/components/theme-provider';
import { getAntdTheme } from '@/theme/antd-theme';

export function AntdBridge({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const antdThemeConfig = useMemo(() => getAntdTheme(isDark), [isDark]);

  return (
    <ConfigProvider theme={antdThemeConfig} variant="outlined">
      <App style={{ height: '100%', width: '100%' }}>{children}</App>
    </ConfigProvider>
  );
}
