import { Link } from 'react-router-dom';
import { ArrowRightOutlined, CheckCircleFilled, ExclamationCircleFilled, WarningFilled } from '@ant-design/icons';
import { Space, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';

type Severity = 'ok' | 'warn' | 'err';

export type HeroStat = {
  label: string;
  value: ReactNode;
  href?: string;
  tone?: 'default' | 'warning' | 'error' | 'success';
};

export type HeroStatusBannerProps = {
  /** Pre-computed top-level severity: ok / warn / err. */
  severity: Severity;
  /** Short status headline, e.g. "All systems operational". */
  title: string;
  /** Optional descriptive subtitle (last incident, uptime window, …). */
  subtitle?: string;
  /** Inline mini stats, separated by thin vertical rules in the right zone. */
  stats: HeroStat[];
  /** Right-side action node (e.g. "View 3 alerts" link). */
  action?: ReactNode;
};

const BADGE: Record<Severity, { icon: ReactNode; label: string; className: string }> = {
  ok: { icon: <CheckCircleFilled />, label: 'Operational', className: 'nc-hero-badge nc-hero-badge--ok' },
  warn: { icon: <WarningFilled />, label: 'Degraded', className: 'nc-hero-badge nc-hero-badge--warn' },
  err: { icon: <ExclamationCircleFilled />, label: 'Down', className: 'nc-hero-badge nc-hero-badge--err' },
};

/**
 * HeroStatusBanner — the first thing every operator sees on the dashboard.
 *
 * Replaces the old "System health" AntD Card with a full-width hero band
 * that mirrors how Meraki / Cisco DNA / Mist phrase top-of-page status.
 *
 * Layout:
 *
 *  [severity badge]  Title · subtitle           stat 1 | stat 2 | stat 3 | stat 4  [action]
 *
 * Severity drives background tint + badge tone — never conflate with the
 * primary brand color so the eye reads severity first.
 */
export function HeroStatusBanner({ severity, title, subtitle, stats, action }: HeroStatusBannerProps) {
  const badge = BADGE[severity];
  return (
    <section className={`nc-hero nc-hero--${severity}`} aria-label="System status">
      <div className="nc-hero-main">
        <span className={badge.className} aria-label={`Status: ${badge.label}`}>
          {badge.icon}
          <span>{badge.label}</span>
        </span>
        <div className="nc-hero-titleblock">
          <Typography.Title level={3} className="nc-hero-title" style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          {subtitle ? (
            <Typography.Text type="secondary" className="nc-hero-subtitle">
              {subtitle}
            </Typography.Text>
          ) : null}
        </div>
      </div>

      <div className="nc-hero-stats" role="list">
        {stats.map((stat, idx) => {
          const inner = (
            <div className="nc-hero-stat" role="listitem">
              <div className="nc-hero-stat-label">{stat.label}</div>
              <div className={`nc-hero-stat-value${stat.tone && stat.tone !== 'default' ? ` is-${stat.tone}` : ''}`}>
                {stat.value}
              </div>
            </div>
          );
          return stat.href ? (
            <Link key={idx} to={stat.href} className="nc-hero-stat-link">
              {inner}
            </Link>
          ) : (
            <div key={idx}>{inner}</div>
          );
        })}
      </div>

      {action ? <div className="nc-hero-action">{action}</div> : null}
    </section>
  );
}

/** Helper to build an arrow-link action button. */
export function HeroLink({ to, count, label }: { to: string; count: number; label: string }) {
  return (
    <Link to={to} className="nc-hero-link">
      <Space size={6} align="center">
        {count > 0 ? <Tag color="warning">{count}</Tag> : null}
        <span>{label}</span>
        <ArrowRightOutlined style={{ fontSize: 12 }} />
      </Space>
    </Link>
  );
}
