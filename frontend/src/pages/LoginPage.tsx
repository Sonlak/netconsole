// =============================================================================
// LoginPage — P2 hardening
//
// Three states:
//   1. password form (default)
//   2. MFA challenge (after password accepted, TOTP required)
//   3. (handled by route guard) must-change-password redirect
//
// The MFA challenge shows:
//   - A 6-digit code input (default)
//   - A toggle to enter a backup code instead
//   - A "back to login" link to abandon the challenge
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Space, Typography, Segmented } from 'antd';
import {
  LockOutlined,
  UserOutlined,
  SafetyCertificateOutlined,
  ArrowLeftOutlined,
  KeyOutlined,
  MobileOutlined,
} from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';

const { Title, Text } = Typography;

export default function LoginPage() {
  const navigate = useNavigate();
  const {
    login,
    verifyMfaCode,
    cancelMfa,
    isAuthenticated,
    error,
    clearError,
    pendingMfa,
    isLoading,
  } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [mfaMethod, setMfaMethod] = useState<'totp' | 'backup-code'>('totp');
  const [mfaForm] = Form.useForm();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const onLogin = useCallback(
    async (values: { username: string; password: string }) => {
      setSubmitting(true);
      clearError();
      try {
        await login(values);
        // If `requireTotp` was set, the useAuth hook stored `pendingMfa`
        // and the next render will show the MFA challenge. Nothing
        // else to do here.
      } catch {
        // Error already captured in useAuth state.
      } finally {
        setSubmitting(false);
      }
    },
    [login, clearError],
  );

  const onVerifyMfa = useCallback(
    async (values: { code: string }) => {
      setSubmitting(true);
      clearError();
      try {
        const cleaned = mfaMethod === 'totp'
          ? values.code.replace(/\s/g, '')
          : values.code.replace(/[\s-]/g, '').toUpperCase();
        const ok = await verifyMfaCode(cleaned, mfaMethod);
        if (ok) {
          // useAuth will set isAuthenticated; useEffect above navigates.
        }
      } catch {
        // error already in useAuth state
      } finally {
        setSubmitting(false);
      }
    },
    [verifyMfaCode, mfaMethod, clearError],
  );

  const onBackToLogin = useCallback(() => {
    mfaForm.resetFields();
    cancelMfa();
  }, [mfaForm, cancelMfa]);

  // ───────────────────────────────────────────────────────────────
  // MFA CHALLENGE VIEW
  // ───────────────────────────────────────────────────────────────
  if (pendingMfa) {
    const acceptsBackup = pendingMfa.methods.includes('backup-code');
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
                background: 'linear-gradient(135deg, #10b981 0%, #047857 100%)',
                margin: '0 auto 12px',
                boxShadow: '0 6px 16px rgba(16,185,129,0.4)',
              }}
            >
              <KeyOutlined style={{ fontSize: 28, color: '#fff' }} />
            </div>
            <Title level={3} style={{ margin: 0 }}>
              Two-factor authentication
            </Title>
            <Text type="secondary">Enter a code from your authenticator app</Text>
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

          {acceptsBackup && (
            <div style={{ marginBottom: 12 }}>
              <Segmented
                block
                value={mfaMethod}
                onChange={(v) => {
                  setMfaMethod(v as 'totp' | 'backup-code');
                  mfaForm.resetFields();
                  clearError();
                }}
                options={[
                  { value: 'totp', label: <span><MobileOutlined /> Authenticator</span> },
                  { value: 'backup-code', label: <span><KeyOutlined /> Backup code</span> },
                ]}
              />
            </div>
          )}

          <Form
            form={mfaForm}
            name="mfa"
            onFinish={onVerifyMfa}
            layout="vertical"
            disabled={submitting}
          >
            <Form.Item
              name="code"
              rules={[
                { required: true, message: mfaMethod === 'totp' ? 'Code is required' : 'Backup code is required' },
                {
                  validator: (_, value: string) => {
                    if (!value) return Promise.resolve();
                    if (mfaMethod === 'totp') {
                      if (/^\d{6}$/.test(value.replace(/\s/g, ''))) return Promise.resolve();
                      return Promise.reject(new Error('6 digits expected'));
                    } else {
                      const cleaned = value.replace(/[\s-]/g, '').toUpperCase();
                      if (cleaned.length === 10) return Promise.resolve();
                      return Promise.reject(new Error('10 characters expected'));
                    }
                  },
                },
              ]}
            >
              <Input
                prefix={mfaMethod === 'totp' ? <MobileOutlined /> : <KeyOutlined />}
                placeholder={mfaMethod === 'totp' ? '123456' : 'BACKUPCODE'}
                size="large"
                maxLength={mfaMethod === 'totp' ? 6 : 12}
                autoFocus
                autoComplete="one-time-code"
                style={
                  mfaMethod === 'totp'
                    ? { fontFamily: 'monospace', fontSize: 20, letterSpacing: 4, textAlign: 'center' }
                    : { fontFamily: 'monospace', fontSize: 16, letterSpacing: 2, textAlign: 'center' }
                }
              />
            </Form.Item>

            <Form.Item style={{ marginBottom: 8 }}>
              <Button
                type="primary"
                htmlType="submit"
                block
                size="large"
                loading={submitting || isLoading}
              >
                Verify
              </Button>
            </Form.Item>

            <Button
              block
              size="small"
              type="text"
              icon={<ArrowLeftOutlined />}
              onClick={onBackToLogin}
            >
              Back to login
            </Button>
          </Form>
        </Card>
      </div>
    );
  }

  // ───────────────────────────────────────────────────────────────
  // PASSWORD VIEW (default)
  // ───────────────────────────────────────────────────────────────
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
          onFinish={onLogin}
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
              loading={submitting || isLoading}
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
