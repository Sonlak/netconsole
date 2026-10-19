// =============================================================================
// TotpSetupPage — P2 hardening
//
// Walks the user through 2FA enrollment:
//   1. Click "Start setup" → backend generates a fresh secret + QR + 10
//      backup codes.
//   2. User scans the QR with an authenticator app (Google Authenticator,
//      Authy, 1Password, ...).
//   3. User enters a 6-digit code from the app to confirm the device
//      is working.
//   4. Backend sets `totpEnabled = true` and stamps `totpEnrolledAt`.
//   5. User is told to save their backup codes somewhere safe (e.g.
//      password manager). The page does NOT store the codes locally —
//      they live only in the user's screenshot / password manager.
//
// The page can also DISABLE TOTP (requires current password) and
// REGENERATE backup codes (requires a valid TOTP code, proving the
// user still has the device).
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Button,
  Alert,
  Typography,
  Space,
  Steps,
  QRCode,
  Input,
  Form,
  Result,
  Spin,
  Row,
  Col,
  message,
} from 'antd';
import {
  QrcodeOutlined,
  CheckCircleOutlined,
  KeyOutlined,
  WarningOutlined,
  CopyOutlined,
  DownloadOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  setupTotp,
  verifyTotpSetup,
  getTotpStatus,
  disableTotp,
  regenerateBackupCodes,
} from '../api/totp';
import type { TotpSetupResponse, TotpStatus } from '../api/auth';

const { Title, Paragraph, Text } = Typography;

type Phase = 'loading' | 'idle' | 'setup' | 'verify' | 'enabled' | 'manage' | 'error';

export function TotpSetupPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('loading');
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [codeForm] = Form.useForm();
  const [regenForm] = Form.useForm();
  const [disableForm] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);

  // Load current TOTP status on mount.
  useEffect(() => {
    let cancelled = false;
    getTotpStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setPhase(s.enabled ? 'manage' : 'idle');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load TOTP status');
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startSetup = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      const resp = await setupTotp();
      setSetup(resp);
      setPhase('setup');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setSubmitting(false);
    }
  }, []);

  const finishSetup = useCallback(
    async (values: { code: string }) => {
      if (!setup) return;
      setError(null);
      setSubmitting(true);
      try {
        await verifyTotpSetup(values.code);
        setNewBackupCodes(setup.backupCodes); // for the success view
        setPhase('enabled');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Code verification failed');
      } finally {
        setSubmitting(false);
      }
    },
    [setup],
  );

  const handleDisable = useCallback(
    async (values: { currentPassword: string }) => {
      setError(null);
      setSubmitting(true);
      try {
        await disableTotp(values.currentPassword);
        const s = await getTotpStatus();
        setStatus(s);
        setPhase('idle');
        message.success('Two-factor authentication has been disabled.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Disable failed');
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  const handleRegenerate = useCallback(
    async (values: { code: string }) => {
      setError(null);
      setSubmitting(true);
      try {
        const resp = await regenerateBackupCodes(values.code);
        setNewBackupCodes(resp.backupCodes);
        const s = await getTotpStatus();
        setStatus(s);
        setPhase('enabled');
        regenForm.resetFields();
        message.success('Backup codes regenerated.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Regenerate failed');
      } finally {
        setSubmitting(false);
      }
    },
    [regenForm],
  );

  // ────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin size="large" tip="Loading 2FA status..." />
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <Result
        status="error"
        title="Failed to load 2FA status"
        subTitle={error}
        extra={[
          <Button key="retry" onClick={() => window.location.reload()}>
            Retry
          </Button>,
          <Button key="back" onClick={() => navigate('/')}>
            Back to dashboard
          </Button>,
        ]}
      />
    );
  }

  // After successful enrollment, show the recovery codes one more time.
  if (phase === 'enabled' && newBackupCodes) {
    return (
      <Card style={{ maxWidth: 720, margin: '0 auto' }}>
        <Result
          status="success"
          icon={<CheckCircleOutlined />}
          title="Two-factor authentication is now active"
          subTitle="Save your backup codes below. You will not see them again."
        />
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message="Important"
          description="If you lose your authenticator device AND your backup codes, you will be locked out. An admin will need to reset your 2FA before you can log in again."
          style={{ marginBottom: 16 }}
        />
        <Title level={5}>
          <KeyOutlined /> Backup codes
        </Title>
        <Paragraph type="secondary">
          Each code can be used once if you lose access to your authenticator.
        </Paragraph>
        <Row gutter={[8, 8]} style={{ marginBottom: 16 }}>
          {newBackupCodes.map((code, idx) => (
            <Col key={idx} xs={12} sm={8} md={6}>
              <Input
                value={code}
                readOnly
                addonAfter={
                  <CopyOutlined
                    onClick={() => {
                      navigator.clipboard.writeText(code);
                      message.success(`Copied ${code}`);
                    }}
                  />
                }
              />
            </Col>
          ))}
        </Row>
        <Space>
          <Button
            type="primary"
            onClick={() => {
              const blob = new Blob(
                [newBackupCodes.join('\n') + '\n'],
                { type: 'text/plain' },
              );
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'netconsole-backup-codes.txt';
              a.click();
              URL.revokeObjectURL(url);
            }}
            icon={<DownloadOutlined />}
          >
            Download as text
          </Button>
          <Button onClick={() => navigate('/')}>Done</Button>
        </Space>
      </Card>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <Title level={3}>
        <QrcodeOutlined /> Two-Factor Authentication
      </Title>
      <Paragraph type="secondary">
        Add a second factor to your account using a TOTP authenticator app
        (Google Authenticator, Authy, 1Password, etc.).
      </Paragraph>

      {error && (
        <Alert
          type="error"
          message={error}
          showIcon
          closable
          style={{ marginBottom: 16 }}
          onClose={() => setError(null)}
        />
      )}

      {status && status.enabled && (
        <Alert
          type="success"
          showIcon
          message="2FA is enabled on your account"
          description={
            <Space direction="vertical" size="small">
              <span>
                Enrolled: {status.enrolledAt ? new Date(status.enrolledAt).toLocaleString() : '—'}
              </span>
              <span>Backup codes remaining: {status.backupCodesRemaining} of 10</span>
            </Space>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <Card>
        {phase === 'idle' && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Paragraph>
              You haven't enrolled in two-factor authentication yet. Click below to
              start. You'll need an authenticator app on your phone (or laptop).
            </Paragraph>
            <Button type="primary" size="large" onClick={startSetup} loading={submitting}>
              Start setup
            </Button>
          </Space>
        )}

        {phase === 'setup' && setup && (
          <Steps
            direction="vertical"
            current={0}
            items={[
              {
                title: 'Scan the QR code',
                description: (
                  <Space direction="vertical" size="middle" style={{ marginTop: 8 }}>
                    <div>
                      <QRCode value={setup.otpAuthUrl} size={200} />
                    </div>
                    <Paragraph>
                      Or paste this secret into your authenticator app if it
                      doesn't support QR:
                    </Paragraph>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Input.TextArea
                        value={setup.secret}
                        readOnly
                        autoSize={{ minRows: 1, maxRows: 2 }}
                        style={{ flex: 1 }}
                      />
                      <Button
                        icon={<CopyOutlined />}
                        onClick={() => {
                          navigator.clipboard.writeText(setup.secret);
                          message.success('Secret copied');
                        }}
                      >
                        Copy
                      </Button>
                    </div>
                  </Space>
                ),
              },
              {
                title: 'Enter a 6-digit code from your app',
                description: (
                  <Form
                    form={codeForm}
                    layout="inline"
                    onFinish={finishSetup}
                    style={{ marginTop: 8 }}
                  >
                    <Form.Item
                      name="code"
                      rules={[
                        { required: true, message: 'Code is required' },
                        { pattern: /^\d{6}$/, message: '6 digits' },
                      ]}
                    >
                      <Input
                        placeholder="123456"
                        maxLength={6}
                        style={{ width: 160, fontFamily: 'monospace', fontSize: 18 }}
                        autoComplete="one-time-code"
                      />
                    </Form.Item>
                    <Form.Item>
                      <Button type="primary" htmlType="submit" loading={submitting}>
                        Verify
                      </Button>
                    </Form.Item>
                  </Form>
                ),
              },
              {
                title: 'Save your backup codes',
                description: (
                  <Text type="secondary">
                    10 single-use recovery codes will be shown on the next page.
                    Save them in a password manager.
                  </Text>
                ),
              },
            ]}
          />
        )}

        {phase === 'manage' && status?.enabled && (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Card type="inner" title="Regenerate backup codes">
              <Paragraph type="secondary">
                Generates 10 new codes. Your old codes will be invalidated
                immediately. Requires a current 6-digit code from your
                authenticator.
              </Paragraph>
              <Form form={regenForm} layout="inline" onFinish={handleRegenerate}>
                <Form.Item
                  name="code"
                  rules={[
                    { required: true, message: 'Code is required' },
                    { pattern: /^\d{6}$/, message: '6 digits' },
                  ]}
                >
                  <Input
                    placeholder="123456"
                    maxLength={6}
                    style={{ width: 160, fontFamily: 'monospace', fontSize: 16 }}
                    autoComplete="one-time-code"
                  />
                </Form.Item>
                <Form.Item>
                  <Button htmlType="submit" loading={submitting}>
                    Regenerate
                  </Button>
                </Form.Item>
              </Form>
            </Card>

            <Card type="inner" title="Disable 2FA">
              <Paragraph type="secondary">
                Disables 2FA on your account. We strongly recommend keeping 2FA
                on for any account with admin or operator role.
              </Paragraph>
              <Form form={disableForm} layout="inline" onFinish={handleDisable}>
                <Form.Item
                  name="currentPassword"
                  rules={[{ required: true, message: 'Password is required' }]}
                >
                  <Input.Password placeholder="Current password" style={{ width: 220 }} />
                </Form.Item>
                <Form.Item>
                  <Button danger htmlType="submit" loading={submitting}>
                    Disable 2FA
                  </Button>
                </Form.Item>
              </Form>
            </Card>
          </Space>
        )}
      </Card>
    </div>
  );
}

export default TotpSetupPage;
