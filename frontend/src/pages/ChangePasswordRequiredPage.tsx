// =============================================================================
// ChangePasswordRequiredPage — P2 hardening
//
// Shown when the user logs in with `mustChangePassword = true` (set by
// an admin reset, or by the system on first login). The user cannot
// navigate away from this page until they rotate their password. This
// is the entire reason for P2: an attacker who phishes a password
// cannot stop the legitimate user from being forced to set a new one.
//
// The form is the same PUT /api/auth/password that the normal
// settings page uses, plus a `refreshUser()` callback so the
// ProtectedRoute guard no longer blocks navigation.
// =============================================================================

import { useState, useCallback } from 'react';
import { Card, Form, Input, Button, Alert, Typography, Space, Layout, Progress } from 'antd';
import { LockOutlined, KeyOutlined, CheckCircleFilled } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { changePassword } from '../api/auth';
import { useAuth } from '../hooks/useAuth';

const { Title, Paragraph } = Typography;

// Password strength scoring (mirrors the server's policy).
// At least 8 chars, with upper, lower, and digit.
function scorePassword(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 8) score += 25;
  if (pw.length >= 12) score += 15;
  if (/[A-Z]/.test(pw)) score += 20;
  if (/[a-z]/.test(pw)) score += 20;
  if (/[0-9]/.test(pw)) score += 10;
  if (/[^A-Za-z0-9]/.test(pw)) score += 10;
  if (score > 100) score = 100;
  const label =
    score >= 80 ? 'Strong' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Weak';
  const color =
    score >= 80 ? '#52c41a' : score >= 60 ? '#73d13d' : score >= 40 ? '#faad14' : '#ff4d4f';
  return { score, label, color };
}

export function ChangePasswordRequiredPage() {
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pwScore, setPwScore] = useState({ score: 0, label: 'Weak', color: '#ff4d4f' });

  const onValuesChange = useCallback(
    (_changed: unknown, all: { newPassword?: string }) => {
      setPwScore(scorePassword(all.newPassword || ''));
    },
    [],
  );

  const onFinish = useCallback(
    async (values: { currentPassword: string; newPassword: string; confirm: string }) => {
      setError(null);
      if (values.newPassword !== values.confirm) {
        setError('New password and confirmation do not match');
        return;
      }
      if (values.newPassword === values.currentPassword) {
        setError('New password must differ from current password');
        return;
      }
      setSubmitting(true);
      try {
        await changePassword(values.currentPassword, values.newPassword);
        await refreshUser();
        navigate('/', { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Password change failed');
      } finally {
        setSubmitting(false);
      }
    },
    [navigate, refreshUser],
  );

  return (
    <Layout style={{ minHeight: '100vh', background: '#f0f2f5' }}>
      <div style={{ maxWidth: 480, margin: '64px auto', padding: 24 }}>
        <Card>
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <div>
              <Title level={3} style={{ marginBottom: 4 }}>
                <KeyOutlined /> Change your password
              </Title>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {user?.username
                  ? `Hi ${user.username}, your account requires a password change before you can continue.`
                  : 'Your account requires a password change before you can continue.'}
              </Paragraph>
            </div>

            <Alert
              type="info"
              showIcon
              message="Why am I seeing this?"
              description="An administrator has reset your password, or this is your first login. You'll only see this page once."
            />

            {error && <Alert type="error" message={error} showIcon closable />}

            <Form
              form={form}
              layout="vertical"
              onFinish={onFinish}
              onValuesChange={onValuesChange}
              requiredMark
            >
              <Form.Item
                label="Current password"
                name="currentPassword"
                rules={[{ required: true, message: 'Current password is required' }]}
              >
                <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
              </Form.Item>

              <Form.Item
                label="New password"
                name="newPassword"
                rules={[
                  { required: true, message: 'New password is required' },
                  { min: 8, message: 'At least 8 characters' },
                  {
                    pattern: /[A-Z]/,
                    message: 'Must contain at least one uppercase letter',
                  },
                  {
                    pattern: /[a-z]/,
                    message: 'Must contain at least one lowercase letter',
                  },
                  {
                    pattern: /[0-9]/,
                    message: 'Must contain at least one digit',
                  },
                ]}
                extra={
                  pwScore.score > 0 && (
                    <div style={{ marginTop: 4 }}>
                      <Progress
                        percent={pwScore.score}
                        showInfo={false}
                        strokeColor={pwScore.color}
                        size="small"
                      />
                      <span style={{ color: pwScore.color, fontSize: 12 }}>
                        {pwScore.label}
                      </span>
                    </div>
                  )
                }
              >
                <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
              </Form.Item>

              <Form.Item
                label="Confirm new password"
                name="confirm"
                dependencies={['newPassword']}
                rules={[
                  { required: true, message: 'Please confirm your new password' },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('newPassword') === value) {
                        return Promise.resolve();
                      }
                      return Promise.reject(new Error('Passwords do not match'));
                    },
                  }),
                ]}
              >
                <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
              </Form.Item>

              <Form.Item style={{ marginBottom: 0 }}>
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  loading={submitting}
                  icon={<CheckCircleFilled />}
                >
                  Update password
                </Button>
              </Form.Item>
            </Form>
          </Space>
        </Card>
      </div>
    </Layout>
  );
}

export default ChangePasswordRequiredPage;
