import type { ReactNode } from 'react';
import { navigate } from '../router';

const NAV_ITEMS = [
  { path: '/app/dashboard', label: 'Dashboard' },
  { path: '/app/chat', label: 'Chat' },
  { path: '/app/config', label: 'Config' },
  { path: '/app/cron', label: 'Cron' },
  { path: '/app/skills', label: 'Skills' },
];

export default function AdminLayout({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  return (
    <div className="admin-shell fade-in">
      <div className="admin-topbar glass-card">
        <button type="button" className="admin-brand" onClick={() => navigate('/app/dashboard')}>
          管理后台
        </button>
        <nav className="admin-nav" aria-label="Admin navigation">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.path}
              type="button"
              className={`admin-nav-item ${pathname === item.path ? 'active' : ''}`}
              onClick={() => navigate(item.path)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      <main className="admin-main">{children}</main>
    </div>
  );
}
