/**
 * Floating AI Assistant button.
 *
 * Replaces the old header-mounted icon with a production-style FAB
 * (floating action button) at the bottom-right corner — the same
 * pattern used by Notion AI, Linear, Cursor, Vercel, Intercom,
 * etc. Static gradient pill with a soft shadow + hover lift; no
 * looping animation (removed 2026-10-09 — felt too distracting on
 * a page that already has plenty of motion from live data
 * refreshes, fabric highlights, and the drawer's own typing
 * indicator).
 *
 * Visual layers (bottom → top):
 *   1. Gradient pill (theme primary → primary-hover, ~135deg)
 *   2. Soft shadow (theme primary, low alpha) — static
 *   3. Top-edge inner highlight (glass feel)
 *   4. Content: gradient-stroked robot icon + label + ✦ marker
 *
 * Hover: scale 1.05 + lift 1px + stronger shadow. Focus ring
 * comes from the browser's default outline on the AntD button so
 * keyboard users get a visible focus state.
 *
 * Theme support: dark + light, both pull from the same primary so
 * the brand color stays consistent.
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

  const wrapperStyle: CSSProperties = {
    position: 'fixed',
    right: 24,
    bottom: 24,
    zIndex: 100,
    borderRadius: SIZE,
    isolation: 'isolate',
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
  // above" feel. Static — no animation.
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
    <div
      style={wrapperStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Tooltip title="NetConsole Assistant (AI)" placement="left" mouseEnterDelay={0.4}>
        <Button
          type="primary"
          onClick={onOpen}
          style={buttonStyle}
          aria-label="Open AI Assistant"
          icon={
            <RobotOutlined
              style={{ fontSize: 20, color: '#fff', filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.25))' }}
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
  );
}
