import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, fetchWithCsrf } from './api';
import AdminLayout from './layouts/AdminLayout';
import DashboardPage from './pages/app/dashboard/DashboardPage';
import ConfigPage from './pages/app/config/ConfigPage';
import WizardPage from './pages/wizard/WizardPage';
import { navigate, usePathname } from './router';

const DASHBOARD_ROUTE = '/app/dashboard';
const CONFIG_ROUTE = '/app/config';
const LOGIN_ROUTE = '/login';
const WIZARD_ROUTE = '/wizard';

function resolveRoute(pathname: string, authenticated: boolean): string {
  if (!authenticated) return pathname === LOGIN_ROUTE ? pathname : LOGIN_ROUTE;
  if (pathname === DASHBOARD_ROUTE || pathname === CONFIG_ROUTE || pathname === WIZARD_ROUTE) return pathname;
  return DASHBOARD_ROUTE;
}

function LanguageSwitch() {
  const { i18n, t } = useTranslation();
  const locale = i18n.resolvedLanguage?.startsWith('zh') ? 'zh' : 'en';

  return (
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [needsLogin, setNeedsLogin] = useState(false);
  const [tokenInput, setTokenInput] = useState('');

  const [step, setStep] = useState(1);
  const [viewMode, setViewMode] = useState<'wizard' | 'config'>('wizard');
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [currentConfigRaw, setCurrentConfigRaw] = useState<any>(null);

  const [configDraft, setConfigDraft] = useState<any>({
    agent: {
      model: '',
      codeModel: '',
      memoryWindow: 50,
      workspace: '',
      maxMemorySize: 8192,
      consolidationTimeout: 30000,
      subagentTimeout: 0,
    },
    channels: {
      telegram: { enabled: false, token: '', allowFrom: '', proxy: '' },
      cli: { enabled: true },
      dingtalk: { enabled: false, clientId: '', clientSecret: '', robotCode: '', corpId: '', allowFrom: '', keepAlive: false },
      feishu: { enabled: false, appId: '', appSecret: '', allowFrom: '', domain: 'feishu', connectionMode: 'websocket', verificationToken: '' },
      qq: { enabled: false, appId: '', clientSecret: '', allowFrom: '', requireMention: true, apiBase: 'https://api.sgroup.qq.com', wsIntentMask: (1 << 30) | (1 << 12) | (1 << 25) },
    },
    providers: {},
    logLevel: 'info',
  });

  const [selectedProvider, setSelectedProvider] = useState<ProviderMeta | null>(null);
  const [oAuthSessionId, setOAuthSessionId] = useState('');
  const [oAuthCode, setOAuthCode] = useState('');
  const [isOAuthComplete, setIsOAuthComplete] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [customProviderObj, setCustomProviderObj] = useState({ id: 'custom-1', name: 'Custom', api: 'openai', apiFormat: 'openai' as CustomApiFormat, hasApiKey: true, source: 'custom', env: 'API_KEY', apiEnv: 'API_BASE' });
  const [models, setModels] = useState<ModelOption[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [showAdvancedProvider, setShowAdvancedProvider] = useState(false);
  const [oAuthWait, setOAuthWait] = useState(false);
  const [oAuthUserCode, setOAuthUserCode] = useState('');

  const [testMessage, setTestMessage] = useState<string>(() => t('defaultTestMessage'));
  const [chatLog, setChatLog] = useState<{ role: 'user' | 'agent', content: string }[]>([]);
  const [isChatting, setIsChatting] = useState(false);
  const [autoStartState, setAutoStartState] = useState<AutoStartState | null>(null);
  const [startCommand, setStartCommand] = useState('neoclaw');
  const [isStartingAgent, setIsStartingAgent] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [snapshots, setSnapshots] = useState<ConfigSnapshotMeta[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [managementError, setManagementError] = useState('');
  const [managementSuccess, setManagementSuccess] = useState('');
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmingPreview, setConfirmingPreview] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    document.title = t('initTitle');
  }, [locale, t]);

  useEffect(() => {
    const zhDefault = i18n.getFixedT('zh')('defaultTestMessage');
    const enDefault = i18n.getFixedT('en')('defaultTestMessage');
    if (!testMessage || testMessage === zhDefault || testMessage === enDefault) {
      setTestMessage(t('defaultTestMessage'));
    }
  }, [i18n, locale, t, testMessage]);

  useEffect(() => {
    checkContext();
  }, []);

  const providerAuthLabel = (provider: ProviderMeta): string => {
    if (provider.authType === 'oauth') return t('providerOAuthRequired');
    if (provider.id === 'custom') return t('providerCustomFormats');
    return t('providerApiKeyRequired');
  };

  const providerAuthorizeTitle = (providerName: string): string => `${t('authorizePrefix')} ${providerName}`;
  const providerApiKeyPlaceholder = (providerName: string): string => `${t('apiKeyPlaceholderPrefix')} ${providerName} ${t('apiKeyPlaceholderSuffix')}`;
  const providerOverrideApiPlaceholder = (providerName: string): string => `${t('overrideEndpointPrefix')} ${providerName} ${t('overrideEndpointSuffix')}`;
  const providerAuthSuccess = (providerName: string): string => `${t('authSuccessPrefix')} ${providerName}`;
  const customProviderApiFormat = customProviderObj.apiFormat;
  const customBaseUrlPlaceholder = (() => {
    switch (customProviderApiFormat) {
      case 'anthropic':
        return 'https://api.anthropic.com/v1';
      case 'google':
        return 'https://generativelanguage.googleapis.com/v1beta';
      default:
        return 'https://api.your-endpoint.com/v1';
    }
  })();

  const renderLanguageSwitch = () => (
    <div className="language-switch" aria-label={t('languageLabel')}>
      <button type="button" className={`language-btn ${locale === 'zh' ? 'active' : ''}`} onClick={() => i18n.changeLanguage('zh')}>
        {t('languageZh')}
      </button>
      <button type="button" className={`language-btn ${locale === 'en' ? 'active' : ''}`} onClick={() => i18n.changeLanguage('en')}>
        {t('languageEn')}
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
  const testChat = async () => {
    if (!testMessage.trim()) return;
    const msg = testMessage;
    setTestMessage('');
    setChatLog((prev) => [...prev, { role: 'user', content: msg }]);
    setIsChatting(true);
    setError('');
    try {
      const res = await api('/api/chat/test', {
        config: configDraft,
        message: msg,
      });
      if (res.ok) {
        setChatLog((prev) => [...prev, { role: 'agent', content: res.response || t('noOutput') }]);
      } else {
        throw new Error(res.error || t('chatVerifyFailed'));
      }
    } catch (err: any) {
      setChatLog((prev) => [...prev, { role: 'agent', content: `${t('chatFailedPrefix')}: ${err.message}` }]);
    } finally {
      setIsChatting(false);
    }
  };

  const refreshRuntimeStatus = async () => {
    const runtime = await api<RuntimeStatusResponse>('/api/runtime-status');
    setAgentRunning(!!runtime.agent?.running);
  };

  const resolveStepFromConfig = (config: any): number => {
    const model = typeof config?.agent?.model === 'string' ? config.agent.model.trim() : '';
    const workspace = typeof config?.agent?.workspace === 'string' ? config.agent.workspace.trim() : '';
    if (!model) return 1;
    if (!workspace) return 2;
    return 3;
  };

  const applyServerConfig = (config: any) => {
    setCurrentConfigRaw(config);
    setConfigDraft(toFormConfig(config));
  };

  const loadSnapshots = async () => {
    try {
      const { config } = await api('/api/config/current');

      setConfigDraft((prev: any) => ({
        ...prev,
        agent: { ...prev.agent, ...config.agent },
        channels: {
          telegram: { ...config.channels?.telegram, allowFrom: config.channels?.telegram?.allowFrom?.join(',') || '' },
          cli: { ...config.channels?.cli },
          dingtalk: { ...config.channels?.dingtalk, allowFrom: config.channels?.dingtalk?.allowFrom?.join(',') || '' },
          feishu: {
            ...config.channels?.feishu,
            allowFrom: config.channels?.feishu?.allowFrom?.join(',') || '',
            domain: config.channels?.feishu?.domain || 'feishu',
            connectionMode: config.channels?.feishu?.connectionMode || 'websocket',
          },
          qq: {
            ...config.channels?.qq,
            allowFrom: config.channels?.qq?.allowFrom?.join(',') || '',
            apiBase: config.channels?.qq?.apiBase || 'https://api.sgroup.qq.com',
            wsIntentMask: config.channels?.qq?.wsIntentMask || ((1 << 30) | (1 << 12) | (1 << 25)),
          },
        },
        providers: config.providers || {},
        logLevel: config.logLevel || 'info',
      }));

  const refreshBootstrap = async () => {
    try {
      setLoading(true);
      setError('');
      await api('/api/config/current');
      setNeedsLogin(false);
    } catch (err: any) {
      const message = err.message || t('loadFailed');
      if (message.includes('401') || message.toLowerCase().includes('unauthorized')) {
        setNeedsLogin(true);
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshBootstrap();
  }, []);

  useEffect(() => {
    if (loading) return;
    const target = resolveRoute(pathname, !needsLogin);
    if (target !== pathname) navigate(target, { replace: true });
  }, [loading, needsLogin, pathname]);

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
      navigate(DASHBOARD_ROUTE, { replace: true });
    } catch (err: any) {
      setError(err.message || t('invalidToken'));
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetchWithCsrf('/auth/logout', { method: 'POST' });
    } finally {
      setNeedsLogin(true);
      setTokenInput('');
      setError('');
      navigate(LOGIN_ROUTE, { replace: true });
    }
  };

  const handleOpenConfig = () => {
    navigate(pathname === WIZARD_ROUTE ? DASHBOARD_ROUTE : WIZARD_ROUTE);
  };

  if (loading && !needsLogin) {
    return (
      <div className="fade-in auth-container" style={{ marginTop: '20vh' }}>
        <LanguageSwitch />
        <div className="glass-card loading-card">{t('loadingDashboard')}</div>
      </div>
    );
  }

  if (needsLogin) {
    return (
      <div className="fade-in auth-container" style={{ marginTop: '10vh' }}>
        <LanguageSwitch />
        <div className="glass-card login-card login-shell">
          <div className="login-badge">{t('protectedAccess')}</div>
          <h1 className="title">{t('dashboardTitle')}</h1>
          <p className="subtitle">{t('dashboardAccessPrompt')}</p>
          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label className="form-label">{t('accessToken')}</label>
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
              {loading ? t('authenticating') : t('login')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const isConfigRoute = pathname === CONFIG_ROUTE || pathname === WIZARD_ROUTE;

  return (
    <AdminLayout
      pathname={pathname}
      actions={
        <>
          <LanguageSwitch />
          <button type="button" className="btn btn-outline" onClick={handleOpenConfig}>
            {isConfigRoute ? t('backToDashboard') : t('openWizard')}
          </button>
          <button type="button" className="btn btn-outline" onClick={() => void handleLogout()}>
            {t('logout')}
          </button>
        </>
      }
    >
      {pathname === CONFIG_ROUTE ? <ConfigPage onConfigSaved={() => void refreshBootstrap()} /> : null}
      {pathname === WIZARD_ROUTE ? <WizardPage onConfigSaved={() => void refreshBootstrap()} /> : null}
      {pathname === DASHBOARD_ROUTE ? <DashboardPage /> : null}
    </AdminLayout>
        </div>

        {viewMode === 'wizard' && step < 4 && (
          <div className="step-indicator">
            <div className={`step ${step >= 1 ? 'completed' : ''}`}>1</div>
            <div className={`step ${step >= 2 ? (step === 2 ? 'active' : 'completed') : ''}`}>2</div>
            <div className={`step ${step >= 3 ? (step === 3 ? 'active' : 'completed') : ''}`}>3</div>
          </div>
        )}

        {viewMode === 'wizard' && error && <div className="form-group"><div className="error-text" style={{ background: '#fee2e2', padding: '1rem', borderRadius: 8 }}>{error}</div></div>}

        {viewMode === 'wizard' && step === 1 && (
          <div className="fade-in">
            <h2 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>{t('step1Title')}</h2>

            <div className="card-grid" style={{ marginBottom: '2rem' }}>
              {providers.map((provider) => (
                <div
                  key={provider.id}
                  className={`selectable-card ${selectedProvider?.id === provider.id ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedProvider(provider);
                    setError('');
                    setIsOAuthComplete(false);
                    setOAuthWait(false);
                    setOAuthUserCode('');
                  }}
                >
                  <div className="card-title">{provider.name || provider.id}</div>
                  <div className="card-subtitle">{providerAuthLabel(provider)}</div>
                </div>
              ))}
            </div>

            {selectedProvider && (
              <div className="fade-in" style={{ background: '#f9fafb', padding: '1.5rem', borderRadius: 12, border: '1px solid #e5e7eb' }}>
                {selectedProvider.authType === 'oauth' && (
                  <div>
                    <h3 style={{ fontSize: '1rem', marginBottom: '1rem' }}>{providerAuthorizeTitle(selectedProvider.name)}</h3>
                    {!isOAuthComplete ? (
                      <div className="form-group">
                        <button type="button" className="btn btn-primary" onClick={startOAuth} disabled={oAuthWait}>
                          {oAuthWait ? t('initiatingLogin') : t('loginInBrowser')}
                        </button>
                        {oAuthWait && (
                          <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            {oAuthUserCode && (
                              <div style={{ padding: '1rem', background: '#f3f4f6', borderRadius: '8px', border: '1px solid #e5e7eb', textAlign: 'center' }}>
                                <p style={{ fontSize: '0.875rem', color: '#4b5563', marginBottom: '0.5rem' }}>{t('oauthUserCodeHint')}</p>
                                <div style={{ fontSize: '1.5rem', fontWeight: 'bold', letterSpacing: '2px', color: '#111827', userSelect: 'all' }}>
                                  {oAuthUserCode}
                                </div>
                              </div>
                            )}
                            <p style={{ fontSize: '0.875rem', color: '#4b5563', marginTop: oAuthUserCode ? '0.5rem' : '0' }}>{t('oauthCompleteHint')}</p>
                            <button type="button" className="btn btn-secondary" onClick={checkOAuthPoll}>{t('verifyAuthorization')}</button>

                            <hr style={{ margin: '1rem 0', borderColor: '#e5e7eb' }} />

                            <p style={{ fontSize: '0.875rem', color: '#4b5563' }}>{t('oauthManualHint')}</p>
                            <div className="flex-row">
                              <input className="form-input" placeholder={t('authorizationCode')} value={oAuthCode} onChange={(e) => setOAuthCode(e.target.value)} />
                              <button type="button" className="btn btn-outline" onClick={completeManualOAuth}>{t('submitCode')}</button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="success-text" style={{ fontSize: '1rem', fontWeight: 600 }}>
                        {providerAuthSuccess(selectedProvider.name)}
                      </div>
                    )}
                  </div>
                )}

                {selectedProvider.authType === 'api-key' && (
                  <div>
                    <h3 style={{ fontSize: '1rem', marginBottom: '1rem' }}>{t('apiKeyAuthTitle')}</h3>
                    <div className="form-group">
                      <label className="form-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span>{t('apiKeyLabel')}</span>
                        {selectedProvider.doc && (
                          <a href={selectedProvider.doc} target="_blank" rel="noreferrer" style={{ fontSize: '0.85rem', color: '#3b82f6', textDecoration: 'none', fontWeight: 'normal' }}>
                            {t('getApiKey')}
                          </a>
                        )}
                      </label>
                      <input type="password" placeholder={providerApiKeyPlaceholder(selectedProvider.name)} className="form-input" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                      <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: '8px' }}>
                        {t('apiKeyHint')}
                      </p>
                    </div>

                    <div className="advanced-toggle" onClick={() => setShowAdvancedProvider(!showAdvancedProvider)}>
                      {showAdvancedProvider ? t('hideAdvanced') : t('advancedProviderSettings')}
                    </div>
                    {showAdvancedProvider && (
                      <div className="advanced-panel fade-in">
                        <label className="form-label">{t('customBaseUrlOptional')}</label>
                        <input type="text" placeholder={providerOverrideApiPlaceholder(selectedProvider.name)} className="form-input" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
                      </div>
                    )}
                  </div>
                )}

                {selectedProvider.id === 'custom' && (
                  <div className="fade-in">
                    <h3 style={{ fontSize: '1rem', marginBottom: '1rem' }}>{t('customApiEndpointTitle')}</h3>
                    <div className="form-group">
                      <label className="form-label">{t('providerIdLabel')}</label>
                      <input type="text" className="form-input" value={customProviderObj.id} onChange={(e) => setCustomProviderObj({ ...customProviderObj, id: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{t('apiFormatLabel')}</label>
                      <select
                        className="form-select"
                        value={customProviderApiFormat}
                        onChange={(e) => {
                          const nextFormat = e.target.value as CustomApiFormat;
                          setCustomProviderObj({ ...customProviderObj, api: nextFormat, apiFormat: nextFormat });
                        }}
                      >
                        {CUSTOM_API_FORMATS.map((format) => (
                          <option key={format} value={format}>{t(`apiFormatOption.${format}`)}</option>
                        ))}
                      </select>
                      <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: '8px' }}>
                        {t(`apiFormatHint.${customProviderApiFormat}`)}
                      </p>
                    </div>
                    <div className="form-group">
                      <label className="form-label">{t('baseUrlLabel')}</label>
                      <input type="url" placeholder={customBaseUrlPlaceholder} className="form-input" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{t('apiKeyLabel')}</label>
                      <input type="password" placeholder={t('keyIfRequired')} className="form-input" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                    </div>
                  </div>
                )}

                <div className="actions" style={{ marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: 'none' }}>
                  <div />
                  <button
                    className="btn btn-primary"
                    disabled={isFetchingModels || (selectedProvider.authType === 'oauth' && !isOAuthComplete)}
                    onClick={pullModels}
                  >
                    {isFetchingModels ? <><span className="loading-spinner" /> {t('connecting')}</> : t('verifyAndPullModels')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {viewMode === 'wizard' && step === 2 && (
          <div className="fade-in">
            <h2 style={{ marginBottom: '1.5rem', fontSize: '1.25rem' }}>{t('step2Title')}</h2>

            <div className="form-group">
              <label className="form-label">{t('primaryModel')}</label>
              <select className="form-select" value={configDraft.agent.model} onChange={(e) => setConfigDraft({ ...configDraft, agent: { ...configDraft.agent, model: e.target.value } })}>
                {models.length === 0 && <option value="" disabled>{t('noModelsAvailable')}</option>}
                {models.map((model) => (
                  <option key={model.value} value={model.value}>{model.label}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">{t('codeModelOptional')}</label>
              <select className="form-select" value={configDraft.agent.codeModel} onChange={(e) => setConfigDraft({ ...configDraft, agent: { ...configDraft.agent, codeModel: e.target.value } })}>
                <option value="">{t('sameAsPrimaryModel')}</option>
                {models.map((model) => (
                  <option key={model.value} value={model.value}>{model.label}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">{t('workspaceDirectory')}</label>
              <input type="text" className="form-input" placeholder="/Users/name/workspace" value={configDraft.agent.workspace} onChange={(e) => setConfigDraft({ ...configDraft, agent: { ...configDraft.agent, workspace: e.target.value } })} />
            </div>

            <div className="advanced-toggle" onClick={() => setShowAdvancedProvider(!showAdvancedProvider)} style={{ marginTop: '1.5rem' }}>
              {showAdvancedProvider ? t('hideAdvancedTuning') : t('advancedTuning')}
            </div>

            {showAdvancedProvider && (
              <div className="advanced-panel fade-in grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">{t('memoryWindow')}</label>
                  <input type="number" className="form-input" min={1} value={configDraft.agent.memoryWindow} onChange={(e) => setConfigDraft({ ...configDraft, agent: { ...configDraft.agent, memoryWindow: parseInt(e.target.value, 10) } })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('maxMemorySize')}</label>
                  <input type="number" className="form-input" disabled value={configDraft.agent.maxMemorySize} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('consolidationTimeout')}</label>
                  <input type="number" className="form-input" disabled value={configDraft.agent.consolidationTimeout} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('logLevel')}</label>
                  <select className="form-select" value={configDraft.logLevel} onChange={(e) => setConfigDraft({ ...configDraft, logLevel: e.target.value })}>
                    <option value="debug">{t('logDebug')}</option>
                    <option value="info">{t('logInfo')}</option>
                    <option value="warn">{t('logWarn')}</option>
                  </select>
                </div>
              </div>
            )}

            <div className="actions">
              <button className="btn btn-outline" onClick={() => setStep(1)}>{t('back')}</button>
              <button className="btn btn-primary" onClick={() => setStep(3)} disabled={!configDraft.agent.model || !configDraft.agent.workspace}>{t('continue')}</button>
            </div>
          </div>
        )}

        {viewMode === 'wizard' && step === 3 && (
          <div className="fade-in">
            <h2 style={{ marginBottom: '1.5rem', fontSize: '1.25rem' }}>{t('step3Title')}</h2>

            <label className="checkbox-label" style={{ marginBottom: '1rem' }}>
              <input type="checkbox" checked={configDraft.channels.cli.enabled} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, cli: { enabled: e.target.checked } } })} />
              {t('enableCli')}
            </label>

            <label className="checkbox-label" style={{ marginBottom: '1rem' }}>
              <input type="checkbox" checked={configDraft.channels.telegram.enabled} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, telegram: { ...configDraft.channels.telegram, enabled: e.target.checked } } })} />
              {t('enableTelegram')}
            </label>

            {configDraft.channels.telegram.enabled && (
              <div className="advanced-panel fade-in">
                <div className="form-group">
                  <label className="form-label">{t('telegramToken')}</label>
                  <input type="password" placeholder={t('telegramTokenPlaceholder')} className="form-input" value={configDraft.channels.telegram.token} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, telegram: { ...configDraft.channels.telegram, token: e.target.value } } })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('allowedUserIds')}</label>
                  <input type="text" placeholder={t('allowedUserIdsPlaceholder')} className="form-input" value={configDraft.channels.telegram.allowFrom} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, telegram: { ...configDraft.channels.telegram, allowFrom: e.target.value } } })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('proxyEndpointOptional')}</label>
                  <input type="text" placeholder="http://127.0.0.1:7890" className="form-input" value={configDraft.channels.telegram.proxy} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, telegram: { ...configDraft.channels.telegram, proxy: e.target.value } } })} />
                </div>
              </div>
            )}

            <label className="checkbox-label" style={{ marginBottom: '1rem' }}>
              <input type="checkbox" checked={configDraft.channels.dingtalk.enabled} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, dingtalk: { ...configDraft.channels.dingtalk, enabled: e.target.checked } } })} />
              {t('enableDingTalk')}
            </label>

            {configDraft.channels.dingtalk.enabled && (
              <div className="advanced-panel fade-in">
                <div className="form-group">
                  <label className="form-label">{t('clientId')}</label>
                  <input type="text" className="form-input" value={configDraft.channels.dingtalk.clientId} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, dingtalk: { ...configDraft.channels.dingtalk, clientId: e.target.value } } })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('clientSecret')}</label>
                  <input type="password" className="form-input" value={configDraft.channels.dingtalk.clientSecret} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, dingtalk: { ...configDraft.channels.dingtalk, clientSecret: e.target.value } } })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('robotCode')}</label>
                  <input type="text" className="form-input" value={configDraft.channels.dingtalk.robotCode} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, dingtalk: { ...configDraft.channels.dingtalk, robotCode: e.target.value } } })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('corpId')}</label>
                  <input type="text" className="form-input" value={configDraft.channels.dingtalk.corpId} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, dingtalk: { ...configDraft.channels.dingtalk, corpId: e.target.value } } })} />
                </div>
              </div>
            )}

            <label className="checkbox-label" style={{ marginBottom: '1rem' }}>
              <input type="checkbox" checked={configDraft.channels.feishu.enabled} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, feishu: { ...configDraft.channels.feishu, enabled: e.target.checked } } })} />
              {t('enableFeishu')}
            </label>

            {configDraft.channels.feishu.enabled && (
              <div className="advanced-panel fade-in">
                <div className="form-group">
                  <label className="form-label">{t('feishuAppId')}</label>
                  <input type="text" className="form-input" value={configDraft.channels.feishu.appId} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, feishu: { ...configDraft.channels.feishu, appId: e.target.value } } })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('feishuAppSecret')}</label>
                  <input type="password" className="form-input" value={configDraft.channels.feishu.appSecret} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, feishu: { ...configDraft.channels.feishu, appSecret: e.target.value } } })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('allowedUserIds')}</label>
                  <input type="text" placeholder={t('allowedUserIdsPlaceholder')} className="form-input" value={configDraft.channels.feishu.allowFrom} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, feishu: { ...configDraft.channels.feishu, allowFrom: e.target.value } } })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('feishuDomain')}</label>
                  <select className="form-select" value={configDraft.channels.feishu.domain} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, feishu: { ...configDraft.channels.feishu, domain: e.target.value } } })}>
                    <option value="feishu">Feishu</option>
                    <option value="lark">Lark</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('feishuConnectionMode')}</label>
                  <select className="form-select" value={configDraft.channels.feishu.connectionMode} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, feishu: { ...configDraft.channels.feishu, connectionMode: e.target.value } } })}>
                    <option value="websocket">{t('feishuModeWebsocket')}</option>
                    <option value="webhook">{t('feishuModeWebhook')}</option>
                  </select>
                </div>
                {configDraft.channels.feishu.connectionMode === 'webhook' && (
                  <div className="form-group">
                    <label className="form-label">{t('feishuVerificationToken')}</label>
                    <input type="text" className="form-input" value={configDraft.channels.feishu.verificationToken || ''} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, feishu: { ...configDraft.channels.feishu, verificationToken: e.target.value } } })} />
                  </div>
                )}
              </div>
            )}

            <label className="checkbox-label" style={{ marginBottom: '1rem' }}>
              <input type="checkbox" checked={configDraft.channels.qq.enabled} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, qq: { ...configDraft.channels.qq, enabled: e.target.checked } } })} />
              {t('enableQQ')}
            </label>

            {configDraft.channels.qq.enabled && (
              <div className="advanced-panel fade-in">
                <p style={{ color: '#64748b', marginBottom: '1rem', lineHeight: 1.6, fontSize: '0.95rem' }}>{t('qqSetupHint')}</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div className="form-group">
                    <label className="form-label">{t('qqAppId')}</label>
                    <input type="text" placeholder={t('qqAppIdPlaceholder')} className="form-input" value={configDraft.channels.qq.appId} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, qq: { ...configDraft.channels.qq, appId: e.target.value } } })} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t('qqClientSecret')}</label>
                    <input type="password" placeholder={t('qqClientSecretPlaceholder')} className="form-input" value={configDraft.channels.qq.clientSecret} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, qq: { ...configDraft.channels.qq, clientSecret: e.target.value } } })} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t('allowedUserIds')}</label>
                    <input type="text" placeholder={t('qqAllowFromPlaceholder')} className="form-input" value={configDraft.channels.qq.allowFrom} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, qq: { ...configDraft.channels.qq, allowFrom: e.target.value } } })} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t('qqApiBase')}</label>
                    <input type="text" placeholder={t('qqApiBasePlaceholder')} className="form-input" value={configDraft.channels.qq.apiBase || ''} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, qq: { ...configDraft.channels.qq, apiBase: e.target.value } } })} />
                  </div>
                  <div className="form-group">
                    <label className="checkbox-label">
                      <input type="checkbox" checked={configDraft.channels.qq.requireMention !== false} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, qq: { ...configDraft.channels.qq, requireMention: e.target.checked } } })} />
                      {t('qqRequireMention')}
                    </label>
                    <div style={{ color: '#94a3b8', fontSize: '0.85rem', marginTop: '0.35rem' }}>{t('qqRequireMentionHint')}</div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t('qqIntentMask')}</label>
                    <input type="number" placeholder={t('qqIntentMaskPlaceholder')} className="form-input" value={configDraft.channels.qq.wsIntentMask || 0} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, qq: { ...configDraft.channels.qq, wsIntentMask: parseInt(e.target.value || '0', 10) } } })} />
                    <div style={{ color: '#94a3b8', fontSize: '0.85rem', marginTop: '0.35rem' }}>{t('qqIntentMaskHint')}</div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t('qqReconnectBaseMs')}</label>
                    <input type="number" placeholder="1000" className="form-input" value={configDraft.channels.qq.wsReconnectBaseMs || 1000} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, qq: { ...configDraft.channels.qq, wsReconnectBaseMs: parseInt(e.target.value || '0', 10) } } })} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t('qqReconnectMaxMs')}</label>
                    <input type="number" placeholder="30000" className="form-input" value={configDraft.channels.qq.wsReconnectMaxMs || 30000} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, qq: { ...configDraft.channels.qq, wsReconnectMaxMs: parseInt(e.target.value || '0', 10) } } })} />
                  </div>
                  <div className="form-group">
                    <label className="checkbox-label">
                      <input type="checkbox" checked={configDraft.channels.qq.dedupPersist === true} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, qq: { ...configDraft.channels.qq, dedupPersist: e.target.checked } } })} />
                      {t('qqDedupPersist')}
                    </label>
                    <div style={{ color: '#94a3b8', fontSize: '0.85rem', marginTop: '0.35rem' }}>{t('qqDedupPersistHint')}</div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t('qqDedupFile')}</label>
                    <input type="text" placeholder={t('qqDedupFilePlaceholder')} className="form-input" value={configDraft.channels.qq.dedupFile || ''} onChange={(e) => setConfigDraft({ ...configDraft, channels: { ...configDraft.channels, qq: { ...configDraft.channels.qq, dedupFile: e.target.value } } })} />
                  </div>
                </div>
              </div>
            )}

            <div className="actions">
              <button className="btn btn-outline" onClick={() => setStep(2)}>{t('back')}</button>
              <button className="btn btn-primary" onClick={saveConfig} disabled={loading}>{loading ? t('saving') : t('finishAndSave')}</button>
            </div>
          </div>
        )}

        {viewMode === 'wizard' && step === 4 && (
          <div className="fade-in" style={{ padding: '2rem 0' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🎉</div>
              <h2 style={{ marginBottom: '1rem', fontSize: '1.5rem' }}>{t('saveSuccessTitle')}</h2>
              <p className="subtitle">{t('saveSuccessSubtitle')}</p>
            </div>

            <div style={{ background: '#f8fafc', padding: '1.5rem', borderRadius: 12, border: '1px solid #e2e8f0', marginBottom: '2rem', marginTop: '2rem' }}>
              <h3 style={{ fontSize: '1.2rem', marginBottom: '1rem', color: '#0f172a' }}>{t('whatsNextTitle')}</h3>
              <p style={{ color: '#475569', marginBottom: '1rem' }}>{startHint}</p>
              <div style={{ background: '#1e293b', color: '#f8fafc', padding: '1rem', borderRadius: 8, fontFamily: 'monospace', fontSize: '1.1rem', marginBottom: '1rem' }}>
                {resolvedStartCommand}
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
                <button className="btn btn-primary" onClick={startAgent} disabled={isStartingAgent || autoStarted}>
                  {autoStarted ? t('agentStartedButton') : isStartingAgent ? t('startingAgentButton') : t('startAgentButton')}
                </button>
              </div>
              {autoStarted ? (
                <p style={{ color: '#475569', fontSize: '0.9rem' }}>{t('autoStartSuccessSubtitle')}</p>
              ) : (
                <p style={{ color: '#475569', fontSize: '0.9rem' }}>{t('startCommandHint')}</p>
              )}
              {autoStartState?.error && (
                <p style={{ color: '#b91c1c', fontSize: '0.9rem', marginTop: '0.75rem' }}>
                  {t('autoStartErrorPrefix')} {autoStartState.error}
                </p>
              )}
            </div>

            <div style={{ background: '#ffffff', padding: '1.5rem', borderRadius: 12, border: '1px solid #e2e8f0', marginBottom: '2rem' }}>
              <h3 style={{ fontSize: '1.2rem', marginBottom: '1rem', color: '#0f172a' }}>{t('testConnectionTitle')}</h3>
              <p style={{ color: '#475569', marginBottom: '1rem', fontSize: '0.95rem' }}>{t('testConnectionHint')}</p>

              <div className="chat-window" style={{ background: '#f1f5f9', borderRadius: 8, minHeight: '150px', maxHeight: '300px', overflowY: 'auto', padding: '1rem', marginBottom: '1rem' }}>
                {chatLog.length === 0 && <div style={{ color: '#94a3b8', textAlign: 'center', marginTop: '2rem' }}>{t('noMessagesYet')}</div>}
                {chatLog.map((log, idx) => (
                  <div key={idx} style={{ marginBottom: '1rem', textAlign: log.role === 'user' ? 'right' : 'left' }}>
                    <div style={{ display: 'inline-block', maxWidth: '80%', padding: '0.75rem 1rem', borderRadius: 12, background: log.role === 'user' ? '#3b82f6' : '#e2e8f0', color: log.role === 'user' ? '#fff' : '#0f172a', whiteSpace: 'pre-wrap', wordBreak: 'break-word', textAlign: 'left' }}>
                      {log.content}
                    </div>
                  </div>
                ))}
                {isChatting && (
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ display: 'inline-block', padding: '0.75rem 1rem', borderRadius: 12, background: '#e2e8f0', color: '#64748b' }}>
                      {t('thinking')} <span className="loading-spinner" style={{ display: 'inline-block', width: 12, height: 12, borderWidth: 2, borderTopColor: '#64748b', verticalAlign: 'middle', marginLeft: '0.5rem' }} />
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  className="form-input"
                  value={testMessage}
                  onChange={(e) => setTestMessage(e.target.value)}
                  placeholder={t('testPromptPlaceholder')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') testChat();
                  }}
                  disabled={isChatting}
                  style={{ flex: 1 }}
                />
                <button className="btn btn-primary" onClick={testChat} disabled={isChatting || !testMessage.trim()}>{t('send')}</button>
              </div>
            </div>

            <div style={{ textAlign: 'center' }}>
              <button className="btn btn-secondary" onClick={() => window.location.reload()}>{t('returnToOverview')}</button>
            </div>
          </div>
        )}
        {viewMode === 'config' && configManagementPanel}
      </div>

      {previewState && (
        <div className="modal-backdrop" onClick={closePreview}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3>{previewState.title}</h3>
                <p>{previewState.subtitle}</p>
              </div>
              <button type="button" className="btn btn-outline" onClick={closePreview}>
                {t('configPreviewClose')}
              </button>
            </div>

            <div className="modal-meta-grid">
              {previewState.filename && (
                <div className="modal-meta-item">
                  <span>{t('configPreviewFile')}</span>
                  <strong>{previewState.filename}</strong>
                </div>
              )}
              {previewState.snapshot && (
                <>
                  <div className="modal-meta-item">
                    <span>{t('configPreviewSnapshot')}</span>
                    <strong>{formatSnapshotReason(previewState.snapshot.reason, locale)}</strong>
                  </div>
                  <div className="modal-meta-item">
                    <span>{t('configPreviewCreatedAt')}</span>
                    <strong>{formatTimestamp(previewState.snapshot.createdAt, locale)}</strong>
                  </div>
                </>
              )}
              <div className="modal-meta-item">
                <span>{t('configPreviewChangedSections')}</span>
                <strong>{previewSectionLabel}</strong>
              </div>
              <div className="modal-meta-item">
                <span>{t('configPreviewChangedCount')}</span>
                <strong>{previewState.changedPaths.length}</strong>
              </div>
            </div>

            <div className="modal-content-grid">
              <div className="modal-panel">
                <h4>{t('configPreviewChangedPaths')}</h4>
                {previewPathList.length === 0 ? (
                  <div className="config-snapshot-empty">{t('configPreviewNoChanges')}</div>
                ) : (
                  <div className="config-path-list">
                    {previewPathList.map((path) => (
                      <code key={path} className="config-path-chip">{path}</code>
                    ))}
                    {previewState.changedPaths.length > previewPathList.length && (
                      <span className="config-more-paths">
                        {t('configPreviewMorePaths', { count: previewState.changedPaths.length - previewPathList.length })}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="modal-panel">
                <h4>{t('configPreviewConfig')}</h4>
                <pre className="config-preview-json">{JSON.stringify(previewState.config, null, 2)}</pre>
              </div>
            </div>

            <div className="actions" style={{ marginTop: '1.5rem' }}>
              <button type="button" className="btn btn-outline" onClick={closePreview}>
                {t('configPreviewCancel')}
              </button>
              <button type="button" className="btn btn-primary" onClick={confirmPreviewAction} disabled={confirmingPreview}>
                {confirmingPreview
                  ? t('configPreviewApplying')
                  : previewState.mode === 'import'
                    ? t('configPreviewConfirmImport')
                    : t('configPreviewConfirmRollback')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
