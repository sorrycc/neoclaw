import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type ModelOption, type ProviderMeta } from './api';
import {
  buildExportFilename,
  collectChangedPaths,
  downloadJsonFile,
  formatBytes,
  formatSnapshotReason,
  formatTimestamp,
  mergeImportedConfigPreview,
  readJsonFile,
  sanitizePreviewConfig,
  summarizeChangedPaths,
  toFormConfig,
  type ConfigSnapshotMeta,
} from './config-management';

type CustomApiFormat = 'openai' | 'responses' | 'anthropic' | 'google';

type AutoStartState = {
  enabled: boolean;
  started: boolean;
  alreadyStarted?: boolean;
  command?: string;
  error?: string;
};

type SaveConfigResult = {
  startCommand?: string;
};

type RuntimeStatusResponse = {
  agent?: {
    running?: boolean;
  };
};

type CurrentConfigResponse = {
  config: any;
};

type SnapshotListResponse = {
  snapshots: ConfigSnapshotMeta[];
};

type SnapshotPreviewResponse = {
  snapshot: ConfigSnapshotMeta;
  config: any;
};

type ConfigMutationResponse = {
  ok: boolean;
  config: any;
  snapshot?: ConfigSnapshotMeta;
  backup?: ConfigSnapshotMeta;
};

type PreviewState = {
  mode: 'import' | 'rollback';
  title: string;
  subtitle: string;
  config: any;
  changedPaths: string[];
  topSections: string[];
  filename?: string;
  snapshot?: ConfigSnapshotMeta;
  payload?: any;
};

const CUSTOM_API_FORMATS: CustomApiFormat[] = ['openai', 'responses', 'anthropic', 'google'];

export default function App() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage?.startsWith('zh') ? 'zh' : 'en';

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
      <button
        type="button"
        className={`language-btn ${locale === 'zh' ? 'active' : ''}`}
        onClick={() => i18n.changeLanguage('zh')}
      >
        {t('languageZh')}
      </button>
      <button
        type="button"
        className={`language-btn ${locale === 'en' ? 'active' : ''}`}
        onClick={() => i18n.changeLanguage('en')}
      >
        {t('languageEn')}
      </button>
    </div>
  );

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
      setSnapshotsLoading(true);
      const res = await api<SnapshotListResponse>('/api/config/snapshots');
      setSnapshots(res.snapshots || []);
    } catch (err: any) {
      setManagementError(err.message || t('configManagementLoadFailed'));
    } finally {
      setSnapshotsLoading(false);
    }
  };

  const checkContext = async () => {
    try {
      const { config } = await api<CurrentConfigResponse>('/api/config/current');
      applyServerConfig(config);
      await Promise.all([refreshRuntimeStatus(), loadSnapshots()]);
      const res = await api('/api/providers/list');
      setProviders(res.providers || []);
      setLoading(false);
    } catch (err: any) {
      if (err.message.includes('401') || err.message.toLowerCase().includes('unauthorized')) {
        setNeedsLogin(true);
      } else {
        setError(t('failedLoadContext'));
      }
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput }),
      });
      if (!res.ok) throw new Error(t('invalidToken'));
      setNeedsLogin(false);
      checkContext();
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  const startOAuth = async () => {
    if (!selectedProvider) return;
    try {
      setOAuthWait(true);
      const res = await api('/api/providers/auth/start', { providerId: selectedProvider.id });
      if (res.authUrl) {
        window.open(res.authUrl, '_blank');
        setOAuthSessionId(res.oauthSessionId);
        if (res.userCode) {
          setOAuthUserCode(res.userCode);
        }
      }
    } catch (err: any) {
      setError(err.message);
      setOAuthWait(false);
    }
  };

  const checkOAuthPoll = async () => {
    if (!oAuthSessionId) return;
    try {
      const res = await api('/api/providers/auth/poll', { oauthSessionId: oAuthSessionId });
      if (res.status === 'completed' || res.ok) {
        setIsOAuthComplete(true);
        setOAuthWait(false);
      } else if (res.status === 'pending') {
        // Keep waiting, maybe auto-poll in useEffect for real app.
      } else {
        throw new Error(`${t('oauthFailed')}: ${res.error}`);
      }
    } catch (err: any) {
      setError(err.message);
      setOAuthWait(false);
    }
  };

  const completeManualOAuth = async () => {
    if (!oAuthCode || !selectedProvider || !oAuthSessionId) return;
    try {
      await api('/api/providers/auth/complete', { providerId: selectedProvider.id, oauthSessionId: oAuthSessionId, code: oAuthCode });
      setIsOAuthComplete(true);
      setOAuthWait(false);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const pullModels = async () => {
    if (!selectedProvider) return;
    setIsFetchingModels(true);
    setError('');
    try {
      let payload: any = {};
      if (selectedProvider.id === 'custom') {
        payload = {
          mode: 'custom',
          customProvider: {
            ...customProviderObj,
            api: customProviderObj.apiFormat,
            options: {
              ...(apiKey ? { apiKey } : {}),
              ...(baseURL ? { baseURL } : {}),
            },
          },
        };
        setConfigDraft((prev: any) => ({
          ...prev,
          providers: {
            ...prev.providers,
            [customProviderObj.id]: {
              ...customProviderObj,
              api: customProviderObj.apiFormat,
              options: {
                ...(apiKey ? { apiKey } : {}),
                ...(baseURL ? { baseURL } : {}),
              },
            },
          },
        }));
      } else {
        payload = {
          providerId: selectedProvider.id,
          apiKey,
          baseURL,
        };
        setConfigDraft((prev: any) => ({
          ...prev,
          providers: {
            ...prev.providers,
            [selectedProvider.id]: {
              options: {
                ...(apiKey ? { apiKey } : {}),
                ...(baseURL ? { baseURL } : {}),
              },
            },
          },
        }));
      }

      const res = await api('/api/providers/models', payload);
      setModels(res.models || []);

      if (selectedProvider.id === 'custom' && res.provider) {
        setConfigDraft((prev: any) => ({
          ...prev,
          providers: {
            ...prev.providers,
            [res.provider.id]: res.provider,
          },
        }));
      }

      if (res.models && res.models.length > 0) {
        setConfigDraft((prev: any) => ({
          ...prev,
          agent: { ...prev.agent, model: res.models[0].value },
        }));
      }
      setStep(2);
    } catch (err: any) {
      setError(`${t('failedPullModels')}: ${err.message}`);
    } finally {
      setIsFetchingModels(false);
    }
  };

  const saveConfig = async () => {
    try {
      setLoading(true);
      const res = await api<SaveConfigResult>('/api/config/save', configDraft);
      setAutoStartState(null);
      setStartCommand(res.startCommand || 'neoclaw');
      if ((res as any).config) {
        applyServerConfig((res as any).config);
      }
      await refreshRuntimeStatus();
      setStep(4);
    } catch (err: any) {
      let msg = err.message;
      if (err.details && Array.isArray(err.details)) {
        msg += `\n${err.details.join('\n')}`;
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const exportConfig = async () => {
    try {
      setManagementError('');
      setManagementSuccess('');
      const config = await api('/api/config/export');
      downloadJsonFile(config, buildExportFilename());
      setManagementSuccess(t('configExportSuccess'));
    } catch (err: any) {
      setManagementError(err.message || t('configExportFailed'));
    }
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !currentConfigRaw) return;

    try {
      setManagementError('');
      setManagementSuccess('');
      const payload = await readJsonFile(file);
      const merged = mergeImportedConfigPreview(currentConfigRaw, payload);
      const previewConfig = sanitizePreviewConfig(merged);
      const summary = summarizeChangedPaths(collectChangedPaths(currentConfigRaw, previewConfig));
      setPreviewState({
        mode: 'import',
        title: t('configImportPreviewTitle'),
        subtitle: t('configImportPreviewSubtitle'),
        filename: file.name,
        payload,
        config: previewConfig,
        changedPaths: summary.paths,
        topSections: summary.topSections,
      });
    } catch (err: any) {
      setManagementError(`${t('configImportInvalidFile')}: ${err.message}`);
    } finally {
      event.target.value = '';
    }
  };

  const previewSnapshot = async (snapshot: ConfigSnapshotMeta) => {
    try {
      setPreviewLoading(true);
      setManagementError('');
      setManagementSuccess('');
      const res = await api<SnapshotPreviewResponse>(`/api/config/snapshots/${encodeURIComponent(snapshot.id)}`);
      const previewConfig = sanitizePreviewConfig(res.config);
      const summary = summarizeChangedPaths(collectChangedPaths(currentConfigRaw || {}, previewConfig));
      setPreviewState({
        mode: 'rollback',
        title: t('configRollbackPreviewTitle'),
        subtitle: t('configRollbackPreviewSubtitle'),
        snapshot: res.snapshot,
        config: previewConfig,
        changedPaths: summary.paths,
        topSections: summary.topSections,
      });
    } catch (err: any) {
      setManagementError(err.message || t('configSnapshotPreviewFailed'));
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    setPreviewState(null);
    setConfirmingPreview(false);
  };

  const confirmPreviewAction = async () => {
    if (!previewState) return;

    try {
      setConfirmingPreview(true);
      setManagementError('');
      setManagementSuccess('');

      if (previewState.mode === 'import') {
        const res = await api<ConfigMutationResponse>('/api/config/import', previewState.payload);
        applyServerConfig(res.config);
        setStep(resolveStepFromConfig(res.config));
        setViewMode('wizard');
        await loadSnapshots();
        setManagementSuccess(
          res.snapshot
            ? `${t('configImportSuccess')} ${t('configImportSnapshotHint')} ${formatTimestamp(res.snapshot.createdAt, locale)}`
            : t('configImportSuccess'),
        );
      } else {
        const res = await api<ConfigMutationResponse>('/api/config/rollback', { id: previewState.snapshot?.id });
        applyServerConfig(res.config);
        setStep(resolveStepFromConfig(res.config));
        setViewMode('wizard');
        await loadSnapshots();
        setManagementSuccess(
          res.backup
            ? `${t('configRollbackSuccess')} ${t('configRollbackSnapshotHint')} ${formatTimestamp(res.backup.createdAt, locale)}`
            : t('configRollbackSuccess'),
        );
      }

      closePreview();
    } catch (err: any) {
      setManagementError(err.message || t('configMutationFailed'));
    } finally {
      setConfirmingPreview(false);
    }
  };

  const startAgent = async () => {
    try {
      setIsStartingAgent(true);
      const res = await api<AutoStartState>('/api/agent/start', {});
      setAutoStartState(res);
      if (res.command) setStartCommand(res.command);
      if (res.started || res.alreadyStarted) setAgentRunning(true);
    } catch (err: any) {
      setAutoStartState({ enabled: true, started: false, command: startCommand, error: err.message });
    } finally {
      setIsStartingAgent(false);
    }
  };

  const resolvedStartCommand = autoStartState?.command || startCommand || 'neoclaw';
  const autoStarted = agentRunning || !!autoStartState?.started || !!autoStartState?.alreadyStarted;
  const startHint = autoStartState
    ? autoStarted
      ? autoStartState.alreadyStarted
        ? t('autoStartAlreadyHint')
        : t('autoStartSuccessHint')
      : t('autoStartFailedHint')
    : agentRunning ? t('autoStartAlreadyHint') : t('clickStartHint');

  const previewSectionLabel = previewState?.topSections.length
    ? previewState.topSections.join(', ')
    : t('configPreviewNoChanges');

  const previewPathList = previewState?.changedPaths.slice(0, 12) || [];

  const configManagementPanel = (
    <section className="config-management-shell">
      <div className="config-management-card">
        <div className="config-management-header">
          <div>
            <h2 className="config-management-title">{t('configManagementTitle')}</h2>
            <p className="config-management-subtitle">{t('configManagementSubtitle')}</p>
          </div>
        </div>

        <div className="config-management-meta">
          <span>{t('configSavedStatus')}</span>
          <strong>{currentConfigRaw?.agent?.model || t('configNotConfigured')}</strong>
          <span>·</span>
          <span>{currentConfigRaw?.agent?.workspace || t('configWorkspaceMissing')}</span>
          <span>·</span>
          <span>{t('configSnapshotCount', { count: snapshots.length })}</span>
        </div>

        {managementError && <div className="error-text config-feedback config-feedback-error">{managementError}</div>}
        {managementSuccess && <div className="success-text config-feedback config-feedback-success">{managementSuccess}</div>}

        <details className="config-section" open>
          <summary className="config-section-summary">
            <div>
              <strong>{t('configActionsTitle')}</strong>
              <span>{t('configActionsSubtitle')}</span>
            </div>
          </summary>
          <div className="config-section-body">
            <div className="config-management-actions">
              <button type="button" className="btn btn-outline" onClick={exportConfig}>
                {t('configExportButton')}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => fileInputRef.current?.click()}
              >
                {t('configImportButton')}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={handleImportFile}
              />
            </div>
          </div>
        </details>

        <details className="config-section" open>
          <summary className="config-section-summary">
            <div>
              <strong>{t('configHistoryTitle')}</strong>
              <span>{t('configHistorySubtitle')}</span>
            </div>
            <button type="button" className="btn btn-outline" onClick={(event) => { event.preventDefault(); loadSnapshots(); }} disabled={snapshotsLoading}>
              {snapshotsLoading ? t('configSnapshotsRefreshing') : t('configSnapshotsRefresh')}
            </button>
          </summary>
          <div className="config-section-body">
            {snapshots.length === 0 ? (
              <div className="config-snapshot-empty">
                {snapshotsLoading ? t('configSnapshotsLoading') : t('configSnapshotsEmpty')}
              </div>
            ) : (
              <div className="config-snapshot-list">
                {snapshots.map((snapshot) => (
                  <button
                    key={snapshot.id}
                    type="button"
                    className="config-snapshot-item"
                    onClick={() => previewSnapshot(snapshot)}
                    disabled={previewLoading || confirmingPreview}
                  >
                    <div className="config-snapshot-main">
                      <strong>{formatSnapshotReason(snapshot.reason, locale)}</strong>
                      <span>{formatTimestamp(snapshot.createdAt, locale)}</span>
                    </div>
                    <div className="config-snapshot-side">
                      <span>{formatBytes(snapshot.size)}</span>
                      <span>{t('configPreviewRollbackAction')}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </details>
      </div>
    </section>
  );

  if (loading && !needsLogin && step === 1 && providers.length === 0) {
    return (
      <div className="fade-in">
        {renderLanguageSwitch()}
        <div className="auth-container" style={{ marginTop: '20vh' }}>
          <div><span className="loading-spinner dark-spinner" /> {t('loadingContext')}</div>
        </div>
      </div>
    );
  }

  if (needsLogin) {
    return (
      <div className="fade-in">
        {renderLanguageSwitch()}
        <div className="auth-container" style={{ marginTop: '10vh' }}>
          <div className="glass-card" style={{ maxWidth: 420 }}>
            <h1 className="title">{t('configCenterTitle')}</h1>
            <p className="subtitle">{t('loginSubtitle')}</p>
            <form onSubmit={handleLogin}>
              <div className="form-group">
                <label className="form-label">{t('accessToken')}</label>
                <input
                  autoFocus
                  type="password"
                  className="form-input"
                  placeholder={t('accessTokenPlaceholder')}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                />
              </div>
              {error && <div className="error-text" style={{ marginBottom: '1rem' }}>{error}</div>}
              <button className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
                {loading ? t('authenticating') : t('login')}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      {renderLanguageSwitch()}
      <div className="glass-card onboarding-shell">
        <h1 className="title">{t('initTitle')}</h1>
        <p className="subtitle">{t('initSubtitle')}</p>

        <div className="view-toggle" role="tablist" aria-label={t('viewToggleLabel')}>
          <button
            type="button"
            className={`view-toggle-btn ${viewMode === 'wizard' ? 'active' : ''}`}
            onClick={() => setViewMode('wizard')}
          >
            {t('viewWizard')}
          </button>
          <button
            type="button"
            className={`view-toggle-btn ${viewMode === 'config' ? 'active' : ''}`}
            onClick={() => setViewMode('config')}
          >
            {t('viewConfig')}
          </button>
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
