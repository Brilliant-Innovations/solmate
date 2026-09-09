'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Primary navigation, blueprint §20.1 information architecture. Routes fill in from M5a/M8a/M9. */
const SECTIONS: { title: string; items: { href: string; label: string; note?: string }[] }[] = [
  { title: 'Control', items: [{ href: '/', label: 'Control Room' }, { href: '/agent-activity', label: 'Agent Activity' }, { href: '/positions', label: 'Positions' }, { href: '/approvals', label: 'Approval Queue', note: 'LIVE_APPROVAL' }] },
  { title: 'Markets', items: [{ href: '/scanner', label: 'Scanner' }, { href: '/watchlist', label: 'Watchlist' }, { href: '/assets', label: 'Asset Workspace' }] },
  { title: 'Research', items: [{ href: '/history', label: 'Trade History' }, { href: '/strategy-lab', label: 'Strategy Lab' }, { href: '/replay', label: 'Replay Lab' }, { href: '/attribution', label: 'Attribution / Economics' }] },
  { title: 'Autonomy', items: [{ href: '/autonomy', label: 'Skill · Guidelines · Automations · Adversary' }] },
  { title: 'System', items: [{ href: '/risk', label: 'Risk & Policy' }, { href: '/wallet', label: 'Wallet / Custody' }, { href: '/alerts', label: 'Alert Center' }, { href: '/health', label: 'System Health' }, { href: '/readiness', label: 'Live Readiness' }, { href: '/releases', label: 'Releases' }, { href: '/audit', label: 'Audit Log' }, { href: '/settings', label: 'Settings' }] },
];

/** §20.22 mobile operational surface: mode/live state and pause (status bar), equity/exposure/drawdown/reserves and recent actions (Control), positions with close, alerts, the approval queue, agent activity, health summary, wallet. */
const MOBILE: { href: string; label: string }[] = [
  { href: '/', label: 'Control' },
  { href: '/positions', label: 'Positions' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/agent-activity', label: 'Agent' },
  { href: '/health', label: 'Health' },
  { href: '/wallet', label: 'Wallet' },
];

export function MobileNav() {
  const current = usePathname();
  return (
    <nav className="mobile-nav" aria-label="Primary (compact)">
      {MOBILE.map((i) => (
        <Link key={i.href} href={i.href} aria-current={current === i.href ? 'page' : undefined}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

export function Nav() {
  const current = usePathname();
  return (
    <nav className="nav" aria-label="Primary">
      {SECTIONS.map((s) => (
        <div key={s.title}>
          <h2>{s.title}</h2>
          {s.items.map((i) => (
            <Link key={i.href} href={i.href} aria-current={current === i.href ? 'page' : undefined}>
              {i.label}
              {i.note && <span className="muted mono"> · {i.note}</span>}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
