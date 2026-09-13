import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ApiOutlined,
  ApartmentOutlined,
  AlertOutlined,
  CloudServerOutlined,
  ClusterOutlined,
  DashboardOutlined,
  FileTextOutlined,
  FileSearchOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoonOutlined,
  RadarChartOutlined,
  SearchOutlined,
  SettingOutlined,
  SunOutlined,
  TableOutlined,
  UnorderedListOutlined,
  UserOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import { App as AntApp, Avatar, Breadcrumb, Button, Dropdown, Flex, Input, type InputRef, Layout, Menu, Select, Skeleton, Space, Tag, Tooltip, Typography, theme } from 'antd';
import type { MenuProps } from 'antd';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { useSite, SITE_OPTIONS } from '@/components/site-provider';
import { useTheme } from '@/components/theme-provider';
import { useAuth } from '@/hooks/useAuth';
import { setNotifierApi } from '@/lib/jobNotifier';
import { globalSearch, type SearchResultGroup } from '@/api/search';

const { Header, Sider, Content } = Layout;

type NavDef = { key: string; label: string; hint: string; icon: ReactNode };

const NAV: NavDef[] = [
  { key: '/', label: 'Dashboard', hint: 'Exceptions · queue · Kea', icon: <DashboardOutlined /> },
  { key: '/devices', label: 'Devices', hint: 'NKKN · NTMK inventory', icon: <CloudServerOutlined /> },
  { key: '/discovery', label: 'Discovery', hint: 'Scan mgmt ranges', icon: <RadarChartOutlined /> },
  { key: '/fabric', label: 'Floors / Fabric', hint: 'Core · Dist · Access', icon: <ApartmentOutlined /> },
  { key: '/mac-addresses', label: 'MAC Address', hint: 'Switching table', icon: <TableOutlined /> },
  { key: '/arp-addresses', label: 'ARP', hint: 'Neighbor table', icon: <ClusterOutlined /> },
  { key: '/logs', label: 'Logs', hint: 'Syslog · severity · facility', icon: <FileSearchOutlined /> },
  { key: '/logs/alerts', label: 'Alerts', hint: 'Rules · triggered alerts', icon: <AlertOutlined /> },
  { key: '/interfaces', label: 'Ports', hint: 'Device ports · shut / VLAN', icon: <ApiOutlined /> },
  { key: '/generate-config', label: 'Config Studio', hint: 'Draft · commit · rollback', icon: <FileTextOutlined /> },
  { key: '/dhcp', label: 'DHCP', hint: 'Kea DC · relay', icon: <WifiOutlined /> },
  { key: '/jobs', label: 'Jobs', hint: 'Recent activity · last 1000', icon: <UnorderedListOutlined /> },
  { key: '/settings', label: 'Settings', hint: 'Architecture & theme', icon: <SettingOutlined /> },
];

const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  '/': { title: 'Dashboard', subtitle: 'Network ops · NKKN / NTMK' },
  '/logs/alerts': { title: 'Alerts', subtitle: 'Rules · triggered alerts · acknowledge' },
  '/devices': { title: 'Devices', subtitle: 'Core · Dist · Access' },
  '/jobs': { title: 'Jobs', subtitle: 'Recent activity · last 1000' },
  '/discovery': { title: 'Discovery', subtitle: 'Scan mgmt · sync inventory' },
  '/fabric': { title: 'Floors / Fabric', subtitle: 'Site topology · port links' },
  '/mac-addresses': { title: 'MAC Address', subtitle: 'Switching table' },
  '/arp-addresses': { title: 'ARP', subtitle: 'Neighbor table' },
  '/logs': { title: 'Device logs', subtitle: 'Syslog · severity · facility' },
  '/interfaces': { title: 'Ports', subtitle: 'Device ports · shut / VLAN' },
  '/generate-config': { title: 'Config Studio', subtitle: 'Running · draft · commit' },
  '/dhcp': { title: 'DHCP', subtitle: 'Kea datacenter' },
  '/settings': { title: 'Settings', subtitle: 'Architecture and theme' },
};

function pageMeta(pathname: string) {
  if (pathname.startsWith('/devices/')) {
    return { title: 'Device Detail', subtitle: 'Ports · config · ARP/MAC · activity' };
  }
  return PAGE_META[pathname] ?? PAGE_META['/'];
}

// ─── Inline Search ─────────────────────────────────────────────────────────────

const MIN_QUERY = 2;

function InlineSearch({ forwardedRef }: { forwardedRef?: React.RefObject<InputRef | null> }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<InputRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync forwarded ref to the actual InputRef
  useEffect(() => {
    if (!forwardedRef) return;
    (forwardedRef as React.MutableRefObject<InputRef | null>).current = inputRef.current;
  }, [forwardedRef]);

  // Debounced search
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) {
      setResults(null);
      setLoading(false);
      setLatencyMs(null);
      setFocusedIndex(-1);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const t0 = performance.now();
      setLoading(true);
      setError(null);
      globalSearch(trimmed, 3)
        .then((groups) => {
          if (cancelled) return;
          setResults(groups);
          setLatencyMs(Math.round(performance.now() - t0));
          setFocusedIndex(groups.length > 0 ? 0 : -1);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Search failed');
          setResults(null);
          setLatencyMs(Math.round(performance.now() - t0));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Flat list for keyboard nav
  const flatItems = useMemo((): Array<{ href: string; label: string }> => {
    if (!results || results.length === 0) return [];
    const out: Array<{ href: string; label: string }> = [];
    for (const group of results) {
      if (group.url) out.push({ href: group.url, label: `All ${group.label}` });
      for (const item of group.items) out.push({ href: item.href, label: item.primary });
    }
    return out;
  }, [results]);

  const handleNavigate = useCallback((href: string) => {
    navigate(href);
    setQuery('');
    setResults(null);
    setOpen(false);
  }, [navigate]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (focusedIndex >= 0 && flatItems[focusedIndex]) {
        handleNavigate(flatItems[focusedIndex].href);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
      setResults(null);
    }
  };

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0) return;
    const el = document.querySelector(`[data-search-idx="${focusedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const showResults = query.trim().length >= MIN_QUERY;
  let flatIdx = 0;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <Input
        ref={inputRef}
        prefix={<SearchOutlined />}
        placeholder="Search…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        className="nc-app-search"
        style={{ width: 280 }}
        suffix={
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            ⌘K
          </Typography.Text>
        }
      />

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 1000,
            width: 520,
            background: 'var(--ant-color-bg-container, #fff)',
            borderRadius: 8,
            boxShadow: '0 6px 16px 0 rgba(0,0,0,0.08), 0 3px 6px -4px rgba(0,0,0,0.12)',
            border: '1px solid var(--ant-color-border-secondary, #f0f0f0)',
            marginTop: 4,
            maxHeight: 480,
            overflowY: 'auto',
          }}
        >
          {/* Input area */}
          <div style={{ padding: '8px 12px 6px', borderBottom: '1px solid var(--ant-color-border-secondary, #f0f0f0)' }}>
            {error && (
              <Typography.Text type="danger" style={{ fontSize: 12, display: 'block' }}>
                {error}
              </Typography.Text>
            )}
            {query.trim().length > 0 && query.trim().length < MIN_QUERY && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Type {MIN_QUERY - query.trim().length} more character{MIN_QUERY - query.trim().length > 1 ? 's' : ''} to search
              </Typography.Text>
            )}
          </div>

          {/* Loading */}
          {loading && showResults && (
            <div style={{ padding: '8px 12px 12px' }}>
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} active paragraph={{ rows: 1 }} style={{ marginBottom: 8 }} />
              ))}
            </div>
          )}

          {/* Empty hint */}
          {!loading && !showResults && (
            <div style={{ padding: '24px 16px', textAlign: 'center' }}>
              <SearchOutlined style={{ fontSize: 24, color: '#bfbfbf', display: 'block', marginBottom: 8 }} />
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                Search across devices, ARP, MAC, logs, jobs…
              </Typography.Text>
            </div>
          )}

          {/* Results */}
          {!loading && showResults && results && results.length > 0 && (
            <div>
              {results.map((group) => (
                <div key={group.kind}>
                  {/* Group header */}
                  <div
                    data-search-idx={flatIdx++}
                    onClick={() => group.url && handleNavigate(group.url)}
                    onMouseEnter={() => setFocusedIndex(group.url ? flatIdx - 1 : -1)}
                    style={{
                      padding: '6px 14px 4px',
                      cursor: group.url ? 'pointer' : 'default',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Typography.Text style={{ fontSize: 12, fontWeight: 600 }}>
                      {group.label}
                    </Typography.Text>
                    {group.url && (
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        See all →
                      </Typography.Text>
                    )}
                  </div>

                  {/* Group items */}
                  {group.items.slice(0, 5).map((item, idx) => {
                    const currentIdx = flatIdx++;
                    const isFocused = focusedIndex === currentIdx;
                    return (
                      <div
                        key={idx}
                        data-search-idx={currentIdx}
                        onClick={() => handleNavigate(item.href)}
                        onMouseEnter={() => setFocusedIndex(currentIdx)}
                        style={{
                          padding: '5px 14px',
                          cursor: 'pointer',
                          background: isFocused ? 'var(--ant-color-bg-spotlight, #f5f5f5)' : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <span style={{ fontSize: 13 }}>{item.primary}</span>
                        {item.secondary && (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {item.secondary}
                          </Typography.Text>
                        )}
                        {item.tag && (
                          <Tag
                            color={item.tagColor === 'success' ? 'success' : item.tagColor === 'warning' ? 'warning' : item.tagColor === 'error' ? 'error' : item.tagColor === 'processing' ? 'processing' : 'default'}
                            style={{ flexShrink: 0, margin: 0, fontSize: 11 }}
                          >
                            {item.tag}
                          </Tag>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {/* No results */}
          {!loading && showResults && results && results.length === 0 && !error && (
            <div style={{ padding: '24px 16px', textAlign: 'center' }}>
              <SearchOutlined style={{ fontSize: 28, color: '#bfbfbf', display: 'block', marginBottom: 8 }} />
              <Typography.Text type="secondary">No results for &ldquo;{query}&rdquo;</Typography.Text>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Try a device name, IP address, MAC, or hostname
              </Typography.Text>
            </div>
          )}

          {/* Footer */}
          {(results || loading || error) && (
            <div style={{
              padding: '6px 14px',
              borderTop: '1px solid var(--ant-color-border-secondary, #f0f0f0)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <Flex gap={12}>
                {[['↑↓', 'Navigate'], ['↵', 'Open'], ['Esc', 'Close']].map(([key, label]) => (
                  <Typography.Text key={key} type="secondary" style={{ fontSize: 11 }}>
                    <kbd style={{ background: '#f5f5f5', border: '1px solid #d9d9d9', borderRadius: 4, padding: '1px 5px', fontSize: 11 }}>{key}</kbd>
                    {' '}{label}
                  </Typography.Text>
                ))}
              </Flex>
              {latencyMs !== null && (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {latencyMs} ms
                </Typography.Text>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── App Layout ──────────────────────────────────────────────────────────────

export default function AppLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const { theme: colorMode, toggle } = useTheme();
  const { site, setSite } = useSite();
  // Bind notification / message / modal to the AntApp context so static
  // `notification.success({...})` calls (e.g. from the job notifier
  // after commit) actually render with the current theme tokens.
  const { notification, message } = AntApp.useApp();

  useEffect(() => {
    // Push the bound notification/message instances into the notifier
    // module so commit / rollback completion toasts respect the
    // ConfigProvider theme. The bound instances are stable for the
    // lifetime of this App component, so a single setNotifierApi on
    // mount is enough.
    setNotifierApi({ notification, message });
    return () => setNotifierApi(null);
  }, [notification, message]);

  const [collapsed, setCollapsed] = useState(false);
  const searchInputRef = useRef<InputRef>(null);
  const current = pageMeta(location.pathname);
  const isDark = colorMode === 'dark';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selected = useMemo(() => {
    const match = NAV.find((item) => item.key !== '/' && location.pathname.startsWith(item.key));
    return match?.key ?? '/';
  }, [location.pathname]);

  const menuItems: MenuProps['items'] = [
    {
      key: 'grp-operations',
      type: 'group',
      label: 'Operations',
      children: NAV.slice(0, 4).map((item) => ({
        key: item.key,
        icon: item.icon,
        label: item.label,
      })),
    },
    {
      key: 'grp-network',
      type: 'group',
      label: 'Network',
      children: NAV.slice(4, 9).map((item) => ({
        key: item.key,
        icon: item.icon,
        label: item.label,
      })),
    },
    {
      key: 'grp-system',
      type: 'group',
      label: 'System',
      children: NAV.slice(9).map((item) => ({
        key: item.key,
        icon: item.icon,
        label: item.label,
      })),
    },
  ];

  return (
    <AntApp
      // Bind a single App context so children calling
      // `App.useApp()` (notifier, status banners) share the same
      // theme/config tokens as the static `notification.success(...)`
      // calls we make from the job notifier.
      component={false}
    >
      <Layout className="nc-app-shell">
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        width={220}
        theme="dark"
        className="nc-app-sider"
      >
        <div className="nc-app-logo">
          <img
            src="/logo.png"
            alt="NetConsole"
            className="nc-app-logo-img"
            draggable={false}
            onError={(event) => {
              // Hide the broken-image glyph until the operator drops a real
              // logo at frontend/public/logo.png. Without this the default
              // browser placeholder icon clutters the sidebar.
              (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
            }}
          />
          {!collapsed ? <div className="nc-app-logo-title">NetConsole</div> : null}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header className="nc-app-header" style={{ background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
          <Flex align="center" gap={8} style={{ minWidth: 0 }}>
            <Button
              type="text"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((value) => !value)}
            />
            <div style={{ minWidth: 0 }}>
              <Breadcrumb items={[{ title: 'NetConsole' }, { title: current.title }]} />
            </div>
          </Flex>
          <Space size={8} wrap>
            <Select
              value={site}
              style={{ width: 128 }}
              options={SITE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
              onChange={setSite}
            />
            <InlineSearch forwardedRef={searchInputRef} />
            <Tooltip title={isDark ? 'Light theme' : 'Dark theme'}>
              <Button type="text" aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'} icon={isDark ? <SunOutlined /> : <MoonOutlined />} onClick={toggle} />
            </Tooltip>
            <Tooltip title="Settings">
              <Button type="text" aria-label="Settings" icon={<SettingOutlined />} onClick={() => navigate('/settings')} />
            </Tooltip>
            {user && (
              <Dropdown
                menu={{
                  items: [
                    {
                      key: 'user-info',
                      label: (
                        <div style={{ padding: '4px 0' }}>
                          <div style={{ fontWeight: 600 }}>{user.username}</div>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {user.email} · {user.role}
                          </Typography.Text>
                        </div>
                      ),
                      disabled: true,
                    },
                    { type: 'divider' },
                    {
                      key: 'logout',
                      icon: <LogoutOutlined />,
                      label: 'Sign out',
                      onClick: () => {
                        logout();
                        navigate('/login');
                      },
                    },
                  ],
                }}
                placement="bottomRight"
              >
                <Avatar
                  style={{ cursor: 'pointer', backgroundColor: token.colorPrimary }}
                  icon={<UserOutlined />}
                >
                  {user.username.charAt(0).toUpperCase()}
                </Avatar>
              </Dropdown>
            )}
          </Space>
        </Header>
        <Content className="nc-app-content antd-page">
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </Content>
      </Layout>
      <footer className="nc-app-footer" aria-label="Application version and copyright">
        <div className="nc-app-footer-version">NetConsole 1.2.0</div>
        <div className="nc-app-footer-copy">© 2026 SonLak.</div>
      </footer>
      </Layout>
    </AntApp>
  );
}
