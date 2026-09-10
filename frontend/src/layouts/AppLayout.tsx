import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { App as AntApp, Avatar, type InputRef, Breadcrumb, Button, Dropdown, Flex, Input, Layout, Menu, Modal, Select, Skeleton, Space, Tag, Tooltip, Typography, theme } from 'antd';
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
  const [commandOpen, setCommandOpen] = useState(false);
  const current = pageMeta(location.pathname);
  const isDark = colorMode === 'dark';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
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
            <Input
              readOnly
              prefix={<SearchOutlined />}
              placeholder="Jump to page"
              suffix={
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  ⌘K
                </Typography.Text>
              }
              style={{ width: 180, cursor: 'pointer' }}
              onClick={() => setCommandOpen(true)}
              className="nc-app-search"
            />
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
      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} items={NAV} />
      </Layout>
    </AntApp>
  );
}

function CommandPalette({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: NavDef[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults(null);
      setLoading(false);
      setError(null);
      setFocusedIndex(-1);
    }
  }, [open]);

  // Fetch search results when query grows to 2+ chars
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults(null);
      setLoading(false);
      setFocusedIndex(-1);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    globalSearch(trimmed, 3)
      .then((groups) => {
        if (cancelled) return;
        setResults(groups);
        setFocusedIndex(groups.length > 0 ? 0 : -1);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Search failed');
        setResults(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [query]);

  // Build flat list of all navigable items for keyboard nav
  const flatItems = useMemo((): Array<{ href: string; label: string }> => {
    if (!results || results.length === 0) {
      // Static NAV fallback
      return items
        .filter((item) =>
          `${item.label} ${item.hint}`.toLowerCase().includes(query.trim().toLowerCase())
        )
        .map((item) => ({ href: item.key, label: item.label }));
    }
    // Search results: "open all" headers + individual rows
    const out: Array<{ href: string; label: string }> = [];
    for (const group of results) {
      // Group header row
      if (group.url) {
        out.push({ href: group.url, label: `All ${group.label}` });
      }
      // Individual rows
      for (const item of group.items) {
        out.push({ href: item.href, label: item.primary });
      }
    }
    return out;
  }, [results, items, query]);

  const handleNavigate = (href: string) => {
    navigate(href);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
    }
  };

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0) return;
    const el = document.querySelector(`[data-search-idx="${focusedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const MIN_QUERY = 2;
  const showNav = !loading && (query.trim().length < MIN_QUERY || (!results && !error));
  const showResults = query.trim().length >= MIN_QUERY;
  let flatIdx = 0;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={
        <Flex align="center" gap={8}>
          <SearchOutlined />
          <span>Search</span>
        </Flex>
      }
      destroyOnClose
      styles={{ body: { padding: 0, maxHeight: 480, overflowY: 'auto' } }}
      width={520}
    >
      <div style={{ padding: '12px 16px 8px' }}>
        <Input
          ref={inputRef as React.Ref<InputRef>}
          autoFocus
          prefix={<SearchOutlined />}
          placeholder="Device name, IP, MAC, hostname, log message…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          status={error ? 'error' : undefined}
        />
        {error && (
          <Typography.Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
            {error}
          </Typography.Text>
        )}
        {query.trim().length > 0 && query.trim().length < MIN_QUERY && (
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
            Type {MIN_QUERY - query.trim().length} more character{MIN_QUERY - query.trim().length > 1 ? 's' : ''} to search
          </Typography.Text>
        )}
      </div>

      {/* Loading skeleton */}
      {loading && showResults && (
        <div style={{ padding: '8px 16px 16px' }}>
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} active paragraph={{ rows: 1 }} style={{ marginBottom: 8 }} />
          ))}
        </div>
      )}

      {/* Static NAV fallback when query is short */}
      {!loading && showNav && (
        <Menu
          selectable={false}
          items={items
            .filter((item) =>
              `${item.label} ${item.hint}`.toLowerCase().includes(query.trim().toLowerCase())
            )
            .map((item) => ({
              key: item.key,
              icon: item.icon,
              label: (
                <Flex justify="space-between" gap={12}>
                  <span>{item.label}</span>
                  <Typography.Text type="secondary">{item.hint}</Typography.Text>
                </Flex>
              ),
            }))}
          onClick={({ key }) => handleNavigate(key)}
        />
      )}

      {/* Search results */}
      {!loading && showResults && results && results.length > 0 && (
        <div>
          {results.map((group) => {
            const groupStartIdx = flatIdx;

            return (
              <div key={group.kind}>
                {/* Group header */}
                <div
                  data-search-idx={flatIdx++}
                  onClick={() => group.url && handleNavigate(group.url)}
                  style={{
                    padding: '6px 16px 4px',
                    cursor: group.url ? 'pointer' : 'default',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: focusedIndex === groupStartIdx
                      ? '#f0f5ff'
                      : 'transparent',
                    borderRadius: 6,
                    margin: '0 4px',
                  }}
                  onMouseEnter={() => setFocusedIndex(groupStartIdx)}
                >
                  <Typography.Text strong style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ant-color-text-secondary, #8c8c8c)' }}>
                    {group.label}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {group.total > group.items.length ? `${group.items.length}/${group.total}` : group.total}
                    {' '}
                    <a
                      onClick={(e) => { e.stopPropagation(); if (group.url) handleNavigate(group.url); }}
                      style={{ fontSize: 11 }}
                    >
                      Open all
                    </a>
                  </Typography.Text>
                </div>

                {/* Group rows */}
                {group.items.map((item) => {
                  const idx = flatIdx++;
                  const isFocused = focusedIndex === idx;

                  return (
                    <div
                      key={idx}
                      data-search-idx={idx}
                      onClick={() => handleNavigate(item.href)}
                      onMouseEnter={() => setFocusedIndex(idx)}
                      style={{
                        padding: '7px 16px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: 12,
                        background: isFocused ? '#e6f4ff' : 'transparent',
                        borderRadius: 6,
                        margin: '0 4px',
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <Typography.Text
                          style={{
                            display: 'block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontFamily: 'var(--ant-font-family, monospace)',
                            fontSize: 13,
                          }}
                        >
                          {item.primary}
                        </Typography.Text>
                        <Typography.Text
                          type="secondary"
                          style={{
                            display: 'block',
                            fontSize: 11,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {item.secondary}
                        </Typography.Text>
                      </div>
                      {item.tag && (
                        <Tag
                          color={
                            item.tagColor === 'success' ? 'success'
                            : item.tagColor === 'error'   ? 'error'
                            : item.tagColor === 'warning' ? 'warning'
                            : item.tagColor === 'processing' ? 'processing'
                            : 'default'
                          }
                          style={{ flexShrink: 0, margin: 0, fontSize: 11 }}
                        >
                          {item.tag}
                        </Tag>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* Empty results */}
      {!loading && showResults && results && results.length === 0 && !error && (
        <div style={{ padding: '24px 16px', textAlign: 'center' }}>
          <SearchOutlined style={{ fontSize: 32, color: '#bfbfbf', display: 'block', marginBottom: 8 }} />
          <Typography.Text type="secondary">No results for &ldquo;{query}&rdquo;</Typography.Text>
          <br />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Try a device name, IP address, MAC, or hostname
          </Typography.Text>
        </div>
      )}

      {/* Keyboard hint footer */}
      <div style={{
        padding: '8px 16px',
        borderTop: '1px solid var(--ant.colorBorderSecondary, #f0f0f0)',
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
      }}>
        {[
          ['↑↓', 'Navigate'],
          ['↵', 'Open'],
          ['Esc', 'Close'],
        ].map(([key, label]) => (
          <Typography.Text key={key} type="secondary" style={{ fontSize: 11 }}>
            <kbd style={{
              background: '#f5f5f5',
              border: '1px solid #d9d9d9',
              borderRadius: 4,
              padding: '1px 5px',
              fontFamily: 'inherit',
              fontSize: 11,
            }}>{key}</kbd>
            {' '}{label}
          </Typography.Text>
        ))}
      </div>
    </Modal>
  );
}
