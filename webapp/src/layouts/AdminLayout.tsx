import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { navigate } from '../router';

const DASHBOARD_PATH = '/app/dashboard';

export default function AdminLayout({
  pathname,
  children,
  actions,
}: {
  pathname: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="admin-shell fade-in">
      <header className="admin-topbar glass-card dashboard-header-shell">
        <div>
          <button type="button" className="admin-brand" onClick={() => navigate(DASHBOARD_PATH)}>
            NeoClaw
          </button>
          <p className="admin-tagline">{t('adminTagline')}</p>
        </div>

        <div className="admin-header-actions">
          <button
            type="button"
            className={`admin-nav-item ${pathname === DASHBOARD_PATH ? 'active' : ''}`}
            onClick={() => navigate(DASHBOARD_PATH)}
          >
            {t('navDashboard')}
          </button>
          {actions}
        </div>
      </header>

      <main className="admin-main">{children}</main>
    </div>
  );
}
