import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ApiOutlined,
  ApartmentOutlined,
  AppstoreOutlined,
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
import {
  Avatar,
  Breadcrumb,
  Button,
  Dropdown,
  Flex,
  Input,
  Layout,
  Menu,
  Modal,
  Select,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type { MenuProps } from 'antd';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { useSite, SITE_OPTIONS } from '@/components/site-provider';
import { useTheme } from '@/components/theme-provider';
import { useAuth } from '@/hooks/useAuth';

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
  { key: '/jobs', label: 'Jobs', hint: 'Recent activity · last 100', icon: <UnorderedListOutlined /> },
  { key: '/settings', label: 'Settings', hint: 'Architecture & theme', icon: <SettingOutlined /> },
];

const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  '/': { title: 'Dashboard', subtitle: 'Network ops · NKKN / NTMK' },
  '/logs/alerts': { title: 'Alerts', subtitle: 'Rules · triggered alerts · acknowledge' },
  '/devices': { title: 'Devices', subtitle: 'Core · Dist · Access' },
  '/jobs': { title: 'Jobs', subtitle: 'Recent activity · last 100' },
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
      children: NAV.slice(4, 10).map((item) => ({
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
          <AppstoreOutlined />
          {!collapsed ? (
            <div>
              <div className="nc-app-logo-title">NetConsole</div>
              <div className="nc-app-logo-sub">NKKN · NTMK</div>
            </div>
          ) : null}
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
      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} items={NAV} />
    </Layout>
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

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const filtered = items.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <Modal open={open} onCancel={onClose} footer={null} title="Jump to page" destroyOnClose>
      <Input
        autoFocus
        prefix={<SearchOutlined />}
        placeholder="Devices, MAC, DHCP, Jobs…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onPressEnter={() => {
          if (filtered[0]) {
            navigate(filtered[0].key);
            onClose();
          }
        }}
        style={{ marginBottom: 12 }}
      />
      <Menu
        selectable={false}
        items={filtered.map((item) => ({
          key: item.key,
          icon: item.icon,
          label: (
            <Flex justify="space-between" gap={12}>
              <span>{item.label}</span>
              <Typography.Text type="secondary">{item.hint}</Typography.Text>
            </Flex>
          ),
        }))}
        onClick={({ key }) => {
          navigate(key);
          onClose();
        }}
      />
    </Modal>
  );
}
