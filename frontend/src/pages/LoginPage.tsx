import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd';
import { LockOutlined, UserOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';

const { Title, Text } = Typography;

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, isAuthenticated, error, clearError } = useAuth();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const onFinish = async (values: { username: string; password: string }) => {
    setSubmitting(true);
    await login(values);
    setSubmitting(false);
  };

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%)',
        padding: 16,
      }}
    >
      <Card
        style={{
          width: 420,
          boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
          borderRadius: 12,
        }}
        styles={{ body: { padding: '32px 32px 24px' } }}
      >
        <Space direction="vertical" size={4} style={{ width: '100%', textAlign: 'center', marginBottom: 24 }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 56,
              height: 56,
              borderRadius: 14,
              background: 'linear-gradient(135deg, #3b82f6 0%, #1e40af 100%)',
              margin: '0 auto 12px',
              boxShadow: '0 6px 16px rgba(59,130,246,0.4)',
            }}
          >
            <SafetyCertificateOutlined style={{ fontSize: 28, color: '#fff' }} />
          </div>
          <Title level={3} style={{ margin: 0 }}>
            NetConsole
          </Title>
          <Text type="secondary">Network Management Platform</Text>
        </Space>

        {error && (
          <Alert
            message={error}
            type="error"
            showIcon
            closable
            onClose={clearError}
            style={{ marginBottom: 16 }}
          />
        )}

        <Form
          name="login"
          onFinish={onFinish}
          autoComplete="off"
          layout="vertical"
          disabled={submitting}
        >
          <Form.Item
            name="username"
            rules={[{ required: true, message: 'Please input your username' }]}
          >
            <Input
              prefix={<UserOutlined />}
              placeholder="Username"
              autoFocus
              size="large"
              autoComplete="username"
            />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: 'Please input your password' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="Password"
              size="large"
              autoComplete="current-password"
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 8 }}>
            <Button
              type="primary"
              htmlType="submit"
              block
              size="large"
              loading={submitting}
            >
              Sign in
            </Button>
          </Form.Item>
        </Form>

        <Text
          type="secondary"
          style={{ fontSize: 12, display: 'block', textAlign: 'center', marginTop: 8 }}
        >
          Need access? Contact your administrator.
        </Text>
      </Card>
    </div>
  );
}
