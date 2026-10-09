/**
 * Floating AI Assistant button.
 *
 * Replaces the old header-mounted icon with a production-style FAB
 * (floating action button) at the bottom-right corner — the same
 * pattern used by Notion AI, Linear, Cursor, Vercel, Intercom,
 * etc. Uses the app's primary color as a gradient with a soft glow
 * + idle pulse to feel "alive" without being annoying.
 *
 * Visual layers (bottom → top):
 *   1. Gradient pill (theme primary → primary-hover, ~135deg)
 *   2. Soft glow (box-shadow ring) — same color, low alpha
 *   3. Inner highlight (top 1px white-alpha) — glass feel
 *   4. Idle pulse — slow scale + opacity on the glow ring
 *   5. Content: gradient-stroked robot icon + label + chevron
 *
 * Theme support: dark + light, both pull from the same primary so
 * the brand color stays consistent. Background uses
 * `colorBgContainer` (semi-transparent) so it sits on top of any
 * page without looking like a sticker.
 */

import { useState, type CSSProperties } from 'react';
import { Button, Tooltip, theme } from 'antd';
import { RobotOutlined } from '@ant-design/icons';

type Props = {
  open: boolean;
  onOpen: () => void;
  unread?: number;
};

const SIZE = 52;

export function AssistantFab({ open, onOpen, unread = 0 }: Props) {
  const { token } = theme.useToken();
  const [hover, setHover] = useState(false);

  // The FAB is hidden while the drawer is open — the drawer has its
  // own close affordance and overlapping UI looks messy. We keep
  // it mounted so the open transition feels instant when re-opened.
  if (open) return null;

  const gradient = `linear-gradient(135deg, ${token.colorPrimary} 0%, ${token.colorPrimaryActive} 100%)`;
  const ringShadow = `0 8px 24px -4px ${token.colorPrimary}55, 0 2px 6px rgba(0,0,0,0.12)`;
  const hoverShadow = `0 12px 32px -4px ${token.colorPrimary}77, 0 4px 10px rgba(0,0,0,0.18)`;
  const idleGlow = `0 0 0 0 ${token.colorPrimary}33`;

  const wrapperStyle: CSSProperties = {
    position: 'fixed',
    right: 24,
    bottom: 24,
    zIndex: 100,
    borderRadius: SIZE,
    isolation: 'isolate',
  };

  // The outer ring handles the idle pulse + hover scale. Sits
  // underneath the button content via z-index.
  const ringStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    borderRadius: SIZE,
    background: gradient,
    boxShadow: idleGlow,
    transform: hover ? 'scale(1.05)' : 'scale(1)',
    transition: 'transform 220ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 220ms ease',
    animation: 'nc-assistant-fab-pulse 3.2s ease-in-out infinite',
    pointerEvents: 'none',
  };

  const buttonStyle: CSSProperties = {
    position: 'relative',
    height: SIZE,
    paddingInline: 18,
    borderRadius: SIZE,
    background: gradient,
    border: '1px solid rgba(255, 255, 255, 0.18)',
    color: '#fff',
    fontWeight: 600,
    fontSize: 14,
    letterSpacing: 0.2,
    boxShadow: hover ? hoverShadow : ringShadow,
    transform: hover ? 'translateY(-1px)' : 'translateY(0)',
    transition: 'box-shadow 220ms ease, transform 220ms cubic-bezier(0.4, 0, 0.2, 1)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
  };

  // Top-edge inner highlight gives the pill a glass / "lit from
  // above" feel without needing a real ::before pseudo on AntD's
  // button (which we can't reliably target).
  const highlightStyle: CSSProperties = {
    position: 'absolute',
    top: 1,
    left: 12,
    right: 12,
    height: '40%',
    borderRadius: SIZE,
    background: 'linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 100%)',
    pointerEvents: 'none',
  };

  // Unread pill — small, sits in the top-right of the FAB.
  const unreadStyle: CSSProperties = {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    padding: '0 5px',
    borderRadius: 9,
    background: token.colorError,
    color: '#fff',
    fontSize: 11,
    fontWeight: 700,
    lineHeight: '18px',
    textAlign: 'center',
    boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
    pointerEvents: 'none',
  };

  return (
    <>
      <style>
        {`
        @keyframes nc-assistant-fab-pulse {
          0%   { box-shadow: 0 0 0 0   ${token.colorPrimary}55; }
          70%  { box-shadow: 0 0 0 14px ${token.colorPrimary}00; }
          100% { box-shadow: 0 0 0 0   ${token.colorPrimary}00; }
        }
        @keyframes nc-assistant-fab-shimmer {
          0%, 100% { transform: translateX(-120%); }
          50%      { transform: translateX(120%); }
        }
        .nc-assistant-fab-icon {
          filter: drop-shadow(0 1px 1px rgba(0,0,0,0.25));
        }
        .nc-assistant-fab-shimmer::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 60%;
          height: 100%;
          background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.35) 50%, transparent 100%);
          transform: translateX(-120%);
          animation: nc-assistant-fab-shimmer 4.5s ease-in-out infinite;
          pointer-events: none;
          border-radius: inherit;
        }
        `}
      </style>
      <div
        style={wrapperStyle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <div style={ringStyle} aria-hidden />
        <Tooltip title="NetConsole Assistant (AI)" placement="left" mouseEnterDelay={0.4}>
          <Button
            type="primary"
            onClick={onOpen}
            style={buttonStyle}
            className="nc-assistant-fab-shimmer"
            aria-label="Open AI Assistant"
            icon={
              <RobotOutlined
                className="nc-assistant-fab-icon"
                style={{ fontSize: 20, color: '#fff' }}
              />
            }
          >
            <span>Ask AI</span>
            <span
              aria-hidden
              style={{
                fontSize: 11,
                opacity: 0.85,
                marginLeft: 2,
                transform: 'translateY(-0.5px)',
              }}
            >
              ✦
            </span>
            {unread > 0 && (
              <span style={unreadStyle} aria-label={`${unread} unread`}>
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </Button>
        </Tooltip>
        <div style={highlightStyle} aria-hidden />
      </div>
    </>
  );
}
