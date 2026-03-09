import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import AdminLayout from './layouts/AdminLayout';
import DashboardPage from './pages/app/dashboard/DashboardPage';
import ConfigPage from './pages/app/config/ConfigPage';
import ChatPage from './pages/app/chat/ChatPage';
import CronPage from './pages/app/cron/CronPage';
import SkillsPage from './pages/app/skills/SkillsPage';
import WizardPage from './pages/wizard/WizardPage';
import { navigate, usePathname } from './router';

const APP_ROUTES = new Set(['/wizard', '/app/dashboard', '/app/chat', '/app/config', '/app/cron', '/app/skills']);

function hasBasicConfig(config: any): boolean {
  return Boolean(config?.agent?.model?.trim?.() && config?.agent?.workspace?.trim?.());
}

function resolveRoute(pathname: string, configured: boolean): string {
  if (pathname === '/') return configured ? '/app/dashboard' : '/wizard';
  if (!APP_ROUTES.has(pathname)) return configured ? '/app/dashboard' : '/wizard';
  if (!configured && pathname.startsWith('/app/')) return '/wizard';
  return pathname;
}

function LanguageSwitch() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage?.startsWith('zh') ? 'zh' : 'en';

  return (
    <div className="language-switch" aria-label="language switch">
      <button type="button" className={`language-btn ${locale === 'zh' ? 'active' : ''}`} onClick={() => i18n.changeLanguage('zh')}>
        中文
      </button>
      <button type="button" className={`language-btn ${locale === 'en' ? 'active' : ''}`} onClick={() => i18n.changeLanguage('en')}>
        EN
      </button>
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const [loading, setLoading] = useState(true);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [config, setConfig] = useState<any>(null);

  const configured = useMemo(() => hasBasicConfig(config), [config]);

  const refreshBootstrap = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await api<{ config: any }>('/api/config/current');
      setConfig(res.config);
      setNeedsLogin(false);
    } catch (err: any) {
      const message = err.message || '加载失败';
      if (message.includes('401') || message.toLowerCase().includes('unauthorized')) {
        setNeedsLogin(true);
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshBootstrap();
  }, []);

  useEffect(() => {
    if (loading || needsLogin) return;
    const target = resolveRoute(pathname, configured);
    if (target !== pathname) navigate(target, { replace: true });
  }, [configured, loading, needsLogin, pathname]);

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setLoading(true);
      setError('');
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput }),
      });
      if (!res.ok) throw new Error(t('invalidToken'));
      await refreshBootstrap();
    } catch (err: any) {
      setError(err.message || t('invalidToken'));
      setLoading(false);
    }
  };

  if (loading && !needsLogin) {
    return (
      <div className="fade-in auth-container" style={{ marginTop: '20vh' }}>
        <LanguageSwitch />
        <div className="glass-card loading-card">正在加载 Web 控制台…</div>
      </div>
    );
  }

  if (needsLogin) {
    return (
      <div className="fade-in auth-container" style={{ marginTop: '10vh' }}>
        <LanguageSwitch />
        <div className="glass-card login-card">
          <h1 className="title">{t('configCenterTitle')}</h1>
          <p className="subtitle">请输入 Web access token</p>
          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label className="form-label">Access Token</label>
              <input
                autoFocus
                type="password"
                className="form-input"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                placeholder={t('accessTokenPlaceholder')}
              />
            </div>
            {error && <div className="error-text">{error}</div>}
            <button className="btn btn-primary" style={{ width: '100%', marginTop: '1rem' }} disabled={loading}>
              登录
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (pathname === '/wizard') {
    return (
      <WizardPage onConfigSaved={() => void refreshBootstrap()} />
    );
  }

  let content = <DashboardPage />;
  if (pathname === '/app/chat') content = <ChatPage />;
  if (pathname === '/app/config') content = <ConfigPage onConfigSaved={() => void refreshBootstrap()} />;
  if (pathname === '/app/cron') content = <CronPage />;
  if (pathname === '/app/skills') content = <SkillsPage />;

  return (
    <>
      <LanguageSwitch />
      <AdminLayout pathname={pathname}>{content}</AdminLayout>
    </>
  );
}
