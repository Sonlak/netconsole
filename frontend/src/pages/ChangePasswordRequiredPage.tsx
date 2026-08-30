import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Form, Input, Button, Alert, Typography, Card } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { changePassword } from '../api/auth';
import { useAuth } from '../hooks/useAuth';

const { Title, Text, Paragraph } = Typography;

interface ChangePasswordFormValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export default function ChangePasswordRequiredPage() {
  const navigate = useNavigate();
  const { markPasswordChanged } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFinish = async (values: ChangePasswordFormValues) => {
    setSubmitting(true);
    setError(null);
    try {
      await changePassword(values.currentPassword, values.newPassword);
      markPasswordChanged();
      navigate('/', { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to change password';
      setError(msg);
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        background: 'var(--bg-color, #f0f2f5)',
      }}
    >
      <Card style={{ width: 460, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <Title level={3} style={{ marginBottom: 4 }}>
            Change your password
          </Title>
          <Text type="secondary">First-time setup required</Text>
        </div>

        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="You must change the temporary password before you can use NetConsole."
        />

        {error && (
          <Alert
            message={error}
            type="error"
            closable
            onClose={() => setError(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        <Form
          name="change-password-required"
          onFinish={onFinish}
          autoComplete="off"
          layout="vertical"
          disabled={submitting}
        >
          <Form.Item
            name="currentPassword"
            label="Current password (temporary)"
            rules={[{ required: true, message: 'Please input your current password!' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="Admin@123"
              autoFocus
              size="large"
            />
          </Form.Item>

          <Form.Item
            name="newPassword"
            label="New password"
            rules={[
              { required: true, message: 'Please input a new password!' },
              { min: 8, message: 'Password must be at least 8 characters' },
              {
                pattern: /[A-Z]/,
                message: 'Password must contain at least one uppercase letter',
              },
              {
                pattern: /[a-z]/,
                message: 'Password must contain at least one lowercase letter',
              },
              {
                pattern: /[0-9]/,
                message: 'Password must contain at least one digit',
              },
            ]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="At least 8 chars, mix of upper/lower/digit"
              size="large"
            />
          </Form.Item>

          <Form.Item
            name="confirmPassword"
            label="Confirm new password"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: 'Please confirm your new password!' },
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
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="Re-type new password"
              size="large"
            />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              size="large"
              loading={submitting}
            >
              Set new password & continue
            </Button>
          </Form.Item>
        </Form>

        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0, textAlign: 'center' }}>
          Your token remains valid — you will not need to log in again.
        </Paragraph>
      </Card>
    </div>
  );
}