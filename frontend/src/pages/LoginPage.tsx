// =============================================================================
// LoginPage — Three-stage auth flow
//
// Stages:
//   1. credentials  — username + password (default)
//   2. mfa          — TOTP / backup-code challenge (after password accepted,
//                     when user has 2FA enabled)
//   3. change-password — forced rotation (after password accepted, when
//                     user.mustChangePassword is true; shown BEFORE granting
//                     dashboard access — matches AWS IAM "Require password change
//                     at the next sign-in" pattern, docs.aws.amazon.com/IAM/
//                     latest/UserGuide/id_credentials_passwords_admin-change-user
//                     .html)
//
// After a successful password change the user is signed out (all sessions
// revoked server-side) and returned to the credentials form with a
// success message. They then log in with the new password.
//
// Key security property: access tokens issued under the OLD password are
// killed the moment the password is rotated (authMiddleware compares the
// JWT `iat` against User.passwordChangedAt). The change-password stage
// holds a valid token briefly to call PUT /api/auth/password; after the
// call succeeds, logout() clears it client-side as well.
// =============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Space,
  Typography,
  Segmented,
  Progress,
} from 'antd';
import {
  LockOutlined,
  UserOutlined,
  SafetyCertificateOutlined,
  ArrowLeftOutlined,
  KeyOutlined,
  MobileOutlined,
  CheckCircleFilled,
} from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';
import { changePassword } from '../api/auth';

const { Title, Text } = Typography;

// ─── Password strength ───────────────────────────────────────────────────────────

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

// ─── Layout wrapper ────────────────────────────────────────────────────────────

const CARD_STYLE = {
  width: 420,
  boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
  borderRadius: 12,
};
const CARD_PADDING = { padding: '32px 32px 24px' };
const AUTH_BG =
  'linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%)';

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        background: AUTH_BG,
        padding: 16,
      }}
    >
      {children}
    </div>
  );
}

function LogoHeader() {
  return (
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
  );
}

// ─── MFA challenge stage ──────────────────────────────────────────────────────

function MfaStage({
  pendingMfa,
  mfaMethod,
  setMfaMethod,
  mfaForm,
  onVerifyMfa,
  onBackToLogin,
  submitting,
  error,
  clearError,
}: {
  pendingMfa: { mfaToken: string; methods: ('totp' | 'backup-code')[] };
  mfaMethod: 'totp' | 'backup-code';
  setMfaMethod: (v: 'totp' | 'backup-code') => void;
  mfaForm: ReturnType<typeof Form.useForm<{ code: string }>>[0];
  onVerifyMfa: (values: { code: string }) => Promise<void>;
  onBackToLogin: () => void;
  submitting: boolean;
  error: string | null;
  clearError: () => void;
}) {
  const acceptsBackup = pendingMfa.methods.includes('backup-code');

  return (
    <AuthShell>
      <Card style={CARD_STYLE} styles={{ body: CARD_PADDING }}>
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
              {
                required: true,
                message: mfaMethod === 'totp' ? 'Code is required' : 'Backup code is required',
              },
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
            <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
              Verify
            </Button>
          </Form.Item>

          <Button block size="small" type="text" icon={<ArrowLeftOutlined />} onClick={onBackToLogin}>
            Back to login
          </Button>
        </Form>
      </Card>
    </AuthShell>
  );
}

// ─── Change-password stage ────────────────────────────────────────────────────

function ChangePasswordStage({
  username,
  onBack, // discard the in-flight token and go back to login form
  submitting,
  setSubmitting,
  error,
  setError,
}: {
  username: string;
  onBack: () => void;
  submitting: boolean;
  setSubmitting: (v: boolean) => void;
  error: string | null;
  setError: (v: string | null) => void;
}) {
  const [form] = Form.useForm();
  const [pwScore, setPwScore] = useState({ score: 0, label: 'Weak', color: '#ff4d4f' });

  const onValuesChange = useCallback(
    (_: unknown, all: { newPassword?: string }) => {
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
        onBack(); // signal parent to log out and reset form
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Password change failed');
      } finally {
        setSubmitting(false);
      }
    },
    [onBack, setError, setSubmitting],
  );

  return (
    <AuthShell>
      <Card style={CARD_STYLE} styles={{ body: CARD_PADDING }}>
        <Space direction="vertical" size={4} style={{ width: '100%', textAlign: 'center', marginBottom: 24 }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 56,
              height: 56,
              borderRadius: 14,
              background: 'linear-gradient(135deg, #f59e0b 0%, #b45309 100%)',
              margin: '0 auto 12px',
              boxShadow: '0 6px 16px rgba(245,158,11,0.4)',
            }}
          >
            <KeyOutlined style={{ fontSize: 28, color: '#fff' }} />
          </div>
          <Title level={3} style={{ margin: 0 }}>
            Change your password
          </Title>
          <Text type="secondary">Your account requires a new password before you can continue</Text>
        </Space>

        <Alert
          type="info"
          showIcon
          message="Why am I seeing this?"
          description={`Your administrator has reset your password for the account "${username}". Create a new password to continue.`}
          style={{ marginBottom: 16 }}
        />

        {error && (
          <Alert
            message={error}
            type="error"
            showIcon
            closable
            onClose={() => setError(null)}
            style={{ marginBottom: 16 }}
          />
        )}

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
              pwScore.score > 0 ? (
                <div style={{ marginTop: 4 }}>
                  <Progress
                    percent={pwScore.score}
                    showInfo={false}
                    strokeColor={pwScore.color}
                    size="small"
                  />
                  <span style={{ color: pwScore.color, fontSize: 12 }}>{pwScore.label}</span>
                </div>
              ) : null
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
              size="large"
              loading={submitting}
              icon={<CheckCircleFilled />}
            >
              Update password
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </AuthShell>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

type Stage = 'credentials' | 'mfa' | 'change-password';

export default function LoginPage() {
  const navigate = useNavigate();
  const {
    login,
    verifyMfaCode,
    cancelMfa,
    logout,
    isAuthenticated,
    error,
    clearError,
    pendingMfa,
    isLoading,
    user,
  } = useAuth();

  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [mfaMethod, setMfaMethod] = useState<'totp' | 'backup-code'>('totp');
  const [mfaForm] = Form.useForm<{ code: string }>();
  // Keep the username so we can pre-fill after password change
  const usernameRef = useRef('');

  // ── Stage is DERIVED from auth state, never stored ──────────────────────────
  // An earlier revision kept `stage` in useState and updated it from an effect.
  // That desynced right after a successful OTP verify: `verifyMfaCode` set
  // `pendingMfa` to null and `isAuthenticated` to true, but nothing moved
  // `stage` off 'mfa'. The redirect below was gated on
  // `stage === 'credentials'`, so it never fired and the user was dumped back
  // on the login form even though the session was valid — they had to reload
  // before `hydrate()` picked the token up out of localStorage.
  // Deriving removes the whole class of bug: there is no second copy to drift.
  const stage: Stage = pendingMfa
    ? 'mfa'
    : isAuthenticated && user?.mustChangePassword
      ? 'change-password'
      : 'credentials';

  // ── Redirect to the app once we hold a usable session ───────────────────────
  // Fires for BOTH the plain-password path and the post-OTP path, because
  // `stage` is already back to 'credentials' the moment `pendingMfa` clears.
  useEffect(() => {
    if (stage === 'credentials' && isAuthenticated && !user?.mustChangePassword) {
      navigate('/', { replace: true });
    }
  }, [stage, isAuthenticated, user, navigate]);

  // ── Login ──────────────────────────────────────────────────────────────────

  const handleLogin = useCallback(
    async (values: { username: string; password: string }) => {
      setLocalError(null);
      setSubmitting(true);
      usernameRef.current = values.username;
      try {
        const result = await login(values);
        // login() already updated useAuth state and, if TOTP, set pendingMfa.
        // We check what login() left behind.
        void result; // result = 'ok' | 'require_totp' | 'error'
        // State will re-render; the next render will pick the right branch.
      } catch {
        // error already captured in useAuth state
      } finally {
        setSubmitting(false);
      }
    },
    [login],
  );

  // ── MFA verify ───────────────────────────────────────────────────────────────

  const handleVerifyMfa = useCallback(
    async (values: { code: string }) => {
      setLocalError(null);
      setSubmitting(true);
      try {
        const cleaned =
          mfaMethod === 'totp'
            ? values.code.replace(/\s/g, '')
            : values.code.replace(/[\s-]/g, '').toUpperCase();
        await verifyMfaCode(cleaned, mfaMethod);
        // useAuth state updated; useEffect above will route correctly.
      } catch {
        // error already in useAuth state
      } finally {
        setSubmitting(false);
      }
    },
    [verifyMfaCode, mfaMethod],
  );

  const handleBackToLogin = useCallback(() => {
    mfaForm.resetFields();
    cancelMfa();
  }, [mfaForm, cancelMfa]);

  // ── Password change complete → sign out and show success ─────────────────────

  const handlePasswordChangeDone = useCallback(() => {
    // `logout()` clears isAuthenticated + token + pendingMfa synchronously, so
    // `stage` re-derives to 'credentials' on the next render and the login form
    // comes back with the success banner. No manual stage reset needed.
    logout();
    setLocalError(null);
    setSuccessMessage('Password updated successfully. Sign in with your new password.');
  }, [logout]);

  // ── Render by stage ─────────────────────────────────────────────────────────

  // MFA stage
  if (stage === 'mfa' && pendingMfa) {
    return (
      <MfaStage
        pendingMfa={pendingMfa}
        mfaMethod={mfaMethod}
        setMfaMethod={setMfaMethod}
        mfaForm={mfaForm}
        onVerifyMfa={handleVerifyMfa}
        onBackToLogin={handleBackToLogin}
        submitting={submitting}
        error={error ?? localError}
        clearError={() => { setLocalError(null); clearError(); }}
      />
    );
  }

  // Change-password stage (mustChangePassword = true after login)
  if (stage === 'change-password') {
    return (
      <ChangePasswordStage
        username={user?.username ?? usernameRef.current}
        onBack={handlePasswordChangeDone}
        submitting={submitting}
        setSubmitting={setSubmitting}
        error={localError}
        setError={setLocalError}
      />
    );
  }

  // Credentials stage (default)
  return (
    <AuthShell>
      <Card style={CARD_STYLE} styles={{ body: CARD_PADDING }}>
        <LogoHeader />

        {successMessage && (
          <Alert
            message={successMessage}
            type="success"
            showIcon
            closable
            onClose={() => setSuccessMessage(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        {(error || localError) && (
          <Alert
            message={error ?? localError}
            type="error"
            showIcon
            closable
            onClose={() => { setLocalError(null); clearError(); }}
            style={{ marginBottom: 16 }}
          />
        )}

        <Form
          name="login"
          onFinish={handleLogin}
          autoComplete="off"
          layout="vertical"
          disabled={submitting}
          initialValues={{ username: usernameRef.current || undefined }}
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
    </AuthShell>
  );
}
