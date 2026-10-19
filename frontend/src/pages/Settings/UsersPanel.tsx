import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  PlusOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  StopOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import {
  deleteUser,
  listUsers,
  register,
  resetUserPassword,
  updateUser,
  type User,
  type UserRole,
} from '../../api/auth';
import { adminResetUserTotp } from '../../api/totp';
import { useAuth } from '../../hooks/useAuth';

const { Text } = Typography;

const ROLE_OPTIONS: { value: UserRole; label: string; color: string; description: string }[] = [
  { value: 'ADMIN', label: 'Admin', color: 'red', description: 'Full access — manage users, devices, settings' },
  { value: 'OPERATOR', label: 'Operator', color: 'blue', description: 'Run jobs, edit configs, cannot manage users' },
  { value: 'VIEWER', label: 'Viewer', color: 'default', description: 'Read-only access' },
];

function getRoleMeta(role: string) {
  return ROLE_OPTIONS.find((r) => r.value === role) ?? ROLE_OPTIONS[1];
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '—';
  }
}

export default function UsersPanel() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);

  const [createForm] = Form.useForm<{
    username: string;
    email: string;
    password: string;
    role: UserRole;
  }>();
  const [editForm] = Form.useForm<{ role: UserRole; active: boolean }>();
  const [resetForm] = Form.useForm<{ newPassword: string }>();

  const isSelf = useMemo(
    () => (row: User) => currentUser?.id === row.id,
    [currentUser?.id],
  );

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const { users } = await listUsers();
      setUsers(users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate() {
    try {
      const values = await createForm.validateFields();
      setBusy(true);
      await register({
        username: values.username,
        email: values.email,
        password: values.password,
        role: values.role,
      });
      message.success(`User "${values.username}" created.`);
      setCreateOpen(false);
      createForm.resetFields();
      await refresh();
    } catch (err) {
      if (err instanceof Error) message.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  function openEdit(user: User) {
    setEditing(user);
    editForm.setFieldsValue({ role: user.role as UserRole, active: user.active });
  }

  async function handleEdit() {
    if (!editing) return;
    try {
      const values = await editForm.validateFields();
      setBusy(true);
      await updateUser(editing.id, values);
      message.success(`User "${editing.username}" updated.`);
      setEditing(null);
      await refresh();
    } catch (err) {
      if (err instanceof Error) message.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  function openReset(user: User) {
    setResetting(user);
    resetForm.resetFields();
  }

  async function handleReset() {
    if (!resetting) return;
    try {
      const values = await resetForm.validateFields();
      setBusy(true);
      await resetUserPassword(resetting.id, values.newPassword);
      message.success(`Password updated for "${resetting.username}". User will be prompted to change it on next login.`);
      setResetting(null);
    } catch (err) {
      if (err instanceof Error) message.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  // P2 hardening: clear another user's TOTP enrollment. Used when
  // the user has lost their authenticator AND their backup codes —
  // there is no other way to regain access. Frontend requires
  // confirmation because this is a "trust the admin with the user's
  // 2FA" operation; an attacker who phishes an admin password can
  // take over any 2FA-protected account.
  async function handleResetTotp(user: User) {
    try {
      setBusy(true);
      await adminResetUserTotp(user.id);
      message.success(`TOTP cleared for "${user.username}". User will be prompted to re-enroll on next login.`);
      await refresh();
    } catch (err) {
      if (err instanceof Error) message.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(user: User) {
    try {
      setBusy(true);
      await deleteUser(user.id);
      message.success(`User "${user.username}" deleted.`);
      await refresh();
    } catch (err) {
      if (err instanceof Error) message.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleActive(user: User) {
    try {
      setBusy(true);
      await updateUser(user.id, { active: !user.active });
      message.success(`User "${user.username}" ${user.active ? 'deactivated' : 'activated'}.`);
      await refresh();
    } catch (err) {
      if (err instanceof Error) message.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  const columns: ColumnsType<User> = [
    {
      title: 'Username',
      dataIndex: 'username',
      key: 'username',
      render: (username: string, row) => (
        <Space>
          <Text strong>{username}</Text>
          {isSelf(row) && <Tag color="gold">you</Tag>}
        </Space>
      ),
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      ellipsis: true,
    },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      render: (role: string) => {
        const meta = getRoleMeta(role);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'active',
      key: 'active',
      render: (active: boolean) => (
        <Space size={4}>
          {active ? (
            <Badge status="success" text={<Text type="success">Active</Text>} />
          ) : (
            <Badge status="error" text={<Text type="danger">Inactive</Text>} />
          )}
        </Space>
      ),
    },
    {
      // P2 hardening: 2FA status column. Visible at a glance which
      // accounts are protected (and which high-privilege accounts
      // are NOT). Operators/admins who don't have 2FA on a high-
      // privilege account are flagged in the compliance audit.
      title: '2FA',
      dataIndex: 'totpEnabled',
      key: 'totpEnabled',
      render: (totpEnabled: boolean) =>
        totpEnabled ? (
          <Tag icon={<CheckCircleOutlined />} color="success">
            Enabled
          </Tag>
        ) : (
          <Tag color="default">Off</Tag>
        ),
    },
    {
      // P2 hardening: visual indicator for accounts that have not
      // yet completed the forced-rotation flow.
      title: 'Password',
      dataIndex: 'mustChangePassword',
      key: 'mustChangePassword',
      width: 110,
      render: (mustChange: boolean) =>
        mustChange ? (
          <Tooltip title="User must rotate password on next login">
            <Tag color="warning">Pending</Tag>
          </Tooltip>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            OK
          </Text>
        ),
    },
    {
      title: 'Last login',
      dataIndex: 'lastLoginAt',
      key: 'lastLoginAt',
      render: (value: string | null | undefined, row) => (
        <Tooltip title={row.lastLoginIp ? `IP: ${row.lastLoginIp}` : 'No IP recorded'}>
          <Text type="secondary">{formatDateTime(value)}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (value: string) => <Text type="secondary">{formatDateTime(value)}</Text>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      render: (_, row) => (
        <Space size={4} wrap>
          <Tooltip title={row.active ? 'Deactivate' : 'Activate'}>
            <Button
              size="small"
              type="text"
              icon={row.active ? <StopOutlined /> : <CheckCircleOutlined />}
              onClick={() => handleToggleActive(row)}
              disabled={busy || isSelf(row)}
            />
          </Tooltip>
          <Tooltip title="Edit role">
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => openEdit(row)}
              disabled={busy}
            />
          </Tooltip>
          <Tooltip title="Reset password">
            <Button
              size="small"
              type="text"
              icon={<KeyOutlined />}
              onClick={() => openReset(row)}
              disabled={busy}
            />
          </Tooltip>
          {/* P2 hardening: admin reset-TOTP. Only shown when the
              user has 2FA enrolled (no point resetting an empty
              enrollment). Confirmation modal is inline here because
              Popconfirm's OK button is hard to read. */}
          {row.totpEnabled && (
            <Popconfirm
              title={`Clear TOTP for "${row.username}"?`}
              description={
                <div style={{ maxWidth: 280 }}>
                  Use this if the user has lost their authenticator device AND all
                  backup codes. The user will be required to re-enroll on next
                  login.
                </div>
              }
              okText="Reset TOTP"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleResetTotp(row)}
              disabled={busy}
            >
              <Tooltip title="Reset TOTP (user lost their device + backup codes)">
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<QrcodeOutlined />}
                  disabled={busy}
                />
              </Tooltip>
            </Popconfirm>
          )}
          <Popconfirm
            title={`Delete user "${row.username}"?`}
            description="This action cannot be undone."
            okText="Delete"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(row)}
            disabled={isSelf(row) || busy}
          >
            <Tooltip title={isSelf(row) ? 'Cannot delete yourself' : 'Delete user'}>
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                disabled={isSelf(row) || busy}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      bordered={false}
      title={
        <Space>
          <UserSwitchOutlined />
          <span>Users</span>
          <Tag color="blue">{users.length} total</Tag>
        </Space>
      }
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
            Refresh
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            Create user
          </Button>
        </Space>
      }
    >
      {error && (
        <Alert
          type="error"
          message={error}
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 12 }}
        />
      )}

      <Table<User>
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={users}
        columns={columns}
        pagination={{ pageSize: 10, showSizeChanger: false }}
      />

      {/* Create user modal */}
      <Modal
        title="Create user"
        open={createOpen}
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        onOk={handleCreate}
        confirmLoading={busy}
        okText="Create"
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 8 }} requiredMark="optional">
          <Form.Item
            name="username"
            label="Username"
            rules={[
              { required: true, message: 'Username required' },
              { pattern: /^[a-zA-Z0-9._-]{3,32}$/, message: '3-32 chars: letters, digits, dot, dash, underscore' },
            ]}
          >
            <Input autoFocus placeholder="e.g. operator1" />
          </Form.Item>
          <Form.Item
            name="email"
            label="Email"
            rules={[
              { required: true, message: 'Email required' },
              { type: 'email', message: 'Invalid email' },
            ]}
          >
            <Input placeholder="user@example.com" />
          </Form.Item>
          <Form.Item
            name="password"
            label="Initial password"
            rules={[
              { required: true, message: 'Password required' },
              { min: 8, message: 'At least 8 characters' },
              { pattern: /[A-Z]/, message: 'Must contain uppercase' },
              { pattern: /[a-z]/, message: 'Must contain lowercase' },
              { pattern: /[0-9]/, message: 'Must contain a digit' },
            ]}
          >
            <Input.Password placeholder="Initial password" />
          </Form.Item>
          <Form.Item name="role" label="Role" initialValue="OPERATOR" rules={[{ required: true }]}>
            <Select
              options={ROLE_OPTIONS.map((r) => ({
                value: r.value,
                label: (
                  <Space>
                    <Tag color={r.color}>{r.label}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {r.description}
                    </Text>
                  </Space>
                ),
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit user modal */}
      <Modal
        title={editing ? `Edit "${editing.username}"` : 'Edit user'}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={handleEdit}
        confirmLoading={busy}
        okText="Save"
        destroyOnClose
      >
        {editing && (
          <Form form={editForm} layout="vertical" style={{ marginTop: 8 }}>
            <Form.Item name="role" label="Role" rules={[{ required: true }]}>
              <Select
                disabled={isSelf(editing)}
                options={ROLE_OPTIONS.map((r) => ({ value: r.value, label: r.label }))}
              />
            </Form.Item>
            <Form.Item name="active" label="Status" valuePropName="checked">
              <Select
                disabled={isSelf(editing)}
                options={[
                  { value: true, label: 'Active' },
                  { value: false, label: 'Inactive' },
                ]}
              />
            </Form.Item>
            {isSelf(editing) && (
              <Alert
                type="warning"
                showIcon
                message="You cannot change your own role or deactivate yourself."
              />
            )}
          </Form>
        )}
      </Modal>

      {/* Reset password modal */}
      <Modal
        title={resetting ? `Reset password for "${resetting.username}"` : 'Reset password'}
        open={!!resetting}
        onCancel={() => setResetting(null)}
        onOk={handleReset}
        confirmLoading={busy}
        okText="Reset"
        destroyOnClose
      >
        {resetting && (
          <Form form={resetForm} layout="vertical" style={{ marginTop: 8 }}>
            <Form.Item
              name="newPassword"
              label="New password"
              rules={[
                { required: true, message: 'Password required' },
                { min: 8, message: 'At least 8 characters' },
                { pattern: /[A-Z]/, message: 'Must contain uppercase' },
                { pattern: /[a-z]/, message: 'Must contain lowercase' },
                { pattern: /[0-9]/, message: 'Must contain a digit' },
              ]}
            >
              <Input.Password autoFocus placeholder="Set new password" />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </Card>
  );
}
