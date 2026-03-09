import { useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api';

type UsageCounters = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
};

type DailyUsageBucket = UsageCounters & {
  date: string;
};

type HourlyUsageBucket = UsageCounters & {
  hour: string;
};

type RuntimeStatus = {
  updatedAt: string;
  agent: {
    running: boolean;
    pid: number | null;
    startedAt?: string;
    stoppedAt?: string;
  };
  channels: Record<string, {
    configuredEnabled: boolean;
    running: boolean;
    lastError?: string;
    lastErrorAt?: string;
  }>;
  recentErrors: Array<{
    time: string;
    scope: string;
    message: string;
  }>;
  usage: {
    updatedAt?: string;
    totals: UsageCounters;
    daily: DailyUsageBucket[];
    hourly: HourlyUsageBucket[];
  };
};

type DashboardConfig = {
  agent?: {
    model?: string;
    workspace?: string;
  };
  channels?: Record<string, { enabled?: boolean }>;
};

type Point = {
  label: string;
  value: number;
};

const CHANNEL_ICONS: Record<string, string> = {
  telegram: '✈️',
  dingtalk: '🟦',
  feishu: '🪽',
  cli: '💻',
  system: '🧠',
};

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value || 0);
}

function formatTime(value: string | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatRelative(value: string | undefined, t: TFunction): string {
  if (!value) return t('dashboardNoDataShort');
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return t('dashboardNoDataShort');
  const diffMinutes = Math.round((Date.now() - time) / 60000);
  if (diffMinutes <= 1) return t('dashboardJustNow');
  if (diffMinutes < 60) return t('dashboardMinutesAgo', { count: diffMinutes });
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return t('dashboardHoursAgo', { count: diffHours });
  const diffDays = Math.round(diffHours / 24);
  return t('dashboardDaysAgo', { count: diffDays });
}

function todayKey(): string {
  return new Intl.DateTimeFormat('sv-SE').format(new Date());
}

function buildLinePath(data: Point[]): string {
  if (!data.length) return '';
  const max = Math.max(...data.map((item) => item.value), 1);
  const step = data.length > 1 ? 100 / (data.length - 1) : 100;
  return data
    .map((item, index) => {
      const x = index * step;
      const y = 92 - (item.value / max) * 72;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function SimpleLineChart({
  data,
  emptyLabel,
  peakLabel,
}: {
  data: Point[];
  emptyLabel: string;
  peakLabel: string;
}) {
  if (!data.length) {
    return <div className="chart-empty">{emptyLabel}</div>;
  }

  const path = buildLinePath(data);

  return (
    <div className="chart-shell">
      <svg viewBox="0 0 100 100" className="line-chart" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="dashboardLineFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(99, 102, 241, 0.28)" />
            <stop offset="100%" stopColor="rgba(99, 102, 241, 0.02)" />
          </linearGradient>
        </defs>
        <path d="M 0 92 L 100 92" className="chart-axis" />
        <path d={path} className="chart-line" />
        <path d={`${path} L 100 92 L 0 92 Z`} fill="url(#dashboardLineFill)" className="chart-area" />
      </svg>
      <div className="chart-footer">
        <span>{data[0]?.label}</span>
        <strong>{peakLabel}</strong>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}

function SimpleBarChart({ data, emptyLabel }: { data: Point[]; emptyLabel: string }) {
  if (!data.length) {
    return <div className="chart-empty">{emptyLabel}</div>;
  }

  const max = Math.max(...data.map((item) => item.value), 1);

  return (
    <div className="bar-chart-grid">
      {data.map((item) => (
        <div key={item.label} className="bar-chart-item">
          <div className="bar-chart-track">
            <div className="bar-chart-fill" style={{ height: `${Math.max((item.value / max) * 100, item.value > 0 ? 10 : 4)}%` }} />
          </div>
          <strong>{item.value}</strong>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon: string;
  label: string;
  value: string;
  hint: string;
  tone?: 'default' | 'success' | 'warning';
}) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-icon" aria-hidden="true">{icon}</div>
      <div>
        <div className="metric-label">{label}</div>
        <div className="metric-value">{value}</div>
        <div className="metric-hint">{hint}</div>
      </div>
    </article>
  );
}

export default function DashboardPage() {
  const { t, i18n } = useTranslation();
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [startingAgent, setStartingAgent] = useState(false);
  const [error, setError] = useState('');

  const locale = i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en-US';

  const load = async (silent = false) => {
    try {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError('');
      const [runtimeRes, configRes] = await Promise.all([
        api<RuntimeStatus>('/api/runtime-status'),
        api<{ config: DashboardConfig }>('/api/config/current'),
      ]);
      setRuntime(runtimeRes);
      setConfig(configRes.config);
    } catch (err: any) {
      setError(err.message || t('dashboardLoadFailed'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load(true);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [t]);

  const handleStartAgent = async () => {
    try {
      setStartingAgent(true);
      setError('');
      await api('/api/agent/start', {});
      window.setTimeout(() => {
        void load(true);
      }, 1200);
    } catch (err: any) {
      setError(err.message || t('dashboardStartFailed'));
    } finally {
      setStartingAgent(false);
    }
  };

  const todayUsage = useMemo(() => {
    const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 };
    return runtime?.usage.daily.find((item) => item.date === todayKey()) ?? zero;
  }, [runtime]);

  const enabledChannels = useMemo(
    () => Object.values(config?.channels || {}).filter((channel) => channel?.enabled).length,
    [config],
  );

  const runningChannels = useMemo(
    () => Object.values(runtime?.channels || {}).filter((channel) => channel.running).length,
    [runtime],
  );

  const hourlyTokens = useMemo<Point[]>(() => {
    const buckets = runtime?.usage.hourly.slice(-12) || [];
    return buckets.map((item) => ({
      label: item.hour.slice(11, 16),
      value: item.totalTokens,
    }));
  }, [runtime]);

  const dailyRequests = useMemo<Point[]>(() => {
    const buckets = runtime?.usage.daily.slice(-7) || [];
    return buckets.map((item) => ({
      label: item.date.slice(5),
      value: item.requests,
    }));
  }, [runtime]);

  const channelEntries = useMemo(
    () => Object.entries(runtime?.channels || {}).sort((left, right) => Number(right[1].running) - Number(left[1].running)),
    [runtime],
  );

  if (loading) {
    return <section className="glass-card dashboard-loading">{t('dashboardLoading')}</section>;
  }

  const totalTokens = runtime?.usage.totals.totalTokens || 0;
  const totalRequests = runtime?.usage.totals.requests || 0;
  const hourlyPeak = Math.max(...hourlyTokens.map((item) => item.value), 0);

  return (
    <section className="dashboard-page fade-in">
      <div className="glass-card dashboard-toolbar dashboard-hero">
        <div>
          <h1 className="dashboard-title">{t('dashboardHeroTitle')}</h1>
          <p className="dashboard-subtitle">{t('dashboardHeroSubtitle')}</p>
        </div>
        <div className="dashboard-toolbar-actions dashboard-hero-actions">
          <div className={`status-pill ${runtime?.agent.running ? 'online' : 'offline'}`}>
            <span className="status-dot" aria-hidden="true" />
            {runtime?.agent.running ? t('dashboardRunningBadge') : t('dashboardStoppedBadge')}
          </div>
          <button type="button" className="btn btn-outline" onClick={() => void load(true)} disabled={refreshing}>
            {refreshing ? t('dashboardRefreshing') : t('dashboardRefresh')}
          </button>
          {!runtime?.agent.running && (
            <button type="button" className="btn btn-primary" onClick={() => void handleStartAgent()} disabled={startingAgent}>
              {startingAgent ? t('dashboardStartingAgent') : t('dashboardStartAgent')}
            </button>
          )}
        </div>
      </div>

      {error && <div className="glass-card error-banner">{error}</div>}

      <div className="dashboard-metrics">
        <StatCard
          icon="🪙"
          label={t('dashboardTodayTokens')}
          value={formatNumber(todayUsage.totalTokens, locale)}
          hint={t('dashboardTokenBreakdown', {
            input: formatNumber(todayUsage.inputTokens, locale),
            output: formatNumber(todayUsage.outputTokens, locale),
          })}
          tone="default"
        />
        <StatCard
          icon="📨"
          label={t('dashboardTodayRequests')}
          value={formatNumber(todayUsage.requests, locale)}
          hint={t('dashboardTotalRequests', { total: formatNumber(totalRequests, locale) })}
          tone="default"
        />
        <StatCard
          icon={runtime?.agent.running ? '🟢' : '🟠'}
          label={t('dashboardAgentStatus')}
          value={runtime?.agent.running ? t('dashboardStatusRunning') : t('dashboardStatusIdle')}
          hint={runtime?.agent.running
            ? t('dashboardStartedAt', {
                pid: runtime?.agent.pid ?? '—',
                time: formatTime(runtime?.agent.startedAt, locale),
              })
            : t('dashboardUpdatedAt', { time: formatRelative(runtime?.updatedAt, t) })}
          tone={runtime?.agent.running ? 'success' : 'warning'}
        />
        <StatCard
          icon="🔌"
          label={t('dashboardChannelStatus')}
          value={`${runningChannels}/${enabledChannels}`}
          hint={enabledChannels > 0 ? t('dashboardEnabledChannelsOnline') : t('dashboardNoChannelsEnabled')}
          tone={runningChannels > 0 ? 'success' : 'warning'}
        />
      </div>

      <div className="dashboard-grid two-col">
        <article className="glass-card panel-card">
          <div className="panel-heading">
            <div>
              <h3>{t('dashboardTokenTrendTitle')}</h3>
              <p>{t('dashboardTokenTrendSubtitle')}</p>
            </div>
            <strong>{formatNumber(totalTokens, locale)}</strong>
          </div>
          <SimpleLineChart
            data={hourlyTokens}
            emptyLabel={t('dashboardTokenTrendEmpty')}
            peakLabel={t('dashboardHourlyPeak', { value: formatNumber(hourlyPeak, locale) })}
          />
        </article>

        <article className="glass-card panel-card">
          <div className="panel-heading">
            <div>
              <h3>{t('dashboardRequestTrendTitle')}</h3>
              <p>{t('dashboardRequestTrendSubtitle')}</p>
            </div>
            <strong>{formatNumber(todayUsage.requests, locale)}</strong>
          </div>
          <SimpleBarChart data={dailyRequests} emptyLabel={t('dashboardRequestTrendEmpty')} />
        </article>
      </div>

      <div className="dashboard-grid two-col">
        <article className="glass-card panel-card">
          <div className="panel-heading">
            <div>
              <h3>{t('dashboardOverviewTitle')}</h3>
              <p>{t('dashboardOverviewSubtitle')}</p>
            </div>
          </div>
          <div className="overview-list">
            <div className="overview-item">
              <span>{t('dashboardModel')}</span>
              <strong>{config?.agent?.model || t('dashboardNotConfigured')}</strong>
            </div>
            <div className="overview-item">
              <span>{t('dashboardWorkspace')}</span>
              <strong title={config?.agent?.workspace || ''}>{config?.agent?.workspace || t('dashboardNotConfigured')}</strong>
            </div>
            <div className="overview-item">
              <span>{t('dashboardLastStatusUpdate')}</span>
              <strong>{formatTime(runtime?.updatedAt, locale)}</strong>
            </div>
            <div className="overview-item">
              <span>{t('dashboardLastUsageWrite')}</span>
              <strong>{formatRelative(runtime?.usage.updatedAt, t)}</strong>
            </div>
          </div>
        </article>

        <article className="glass-card panel-card">
          <div className="panel-heading">
            <div>
              <h3>{t('dashboardHealthTitle')}</h3>
              <p>{t('dashboardHealthSubtitle')}</p>
            </div>
          </div>
          <div className="channel-list">
            {channelEntries.length === 0 && <div className="empty-state">{t('dashboardNoChannelData')}</div>}
            {channelEntries.map(([name, channel]) => (
              <div key={name} className="channel-item">
                <div className="channel-meta">
                  <span className="channel-icon" aria-hidden="true">{CHANNEL_ICONS[name] || '•'}</span>
                  <div>
                    <strong>{name}</strong>
                    <p>{channel.configuredEnabled ? t('dashboardChannelConfigured') : t('dashboardChannelNotEnabled')}</p>
                  </div>
                </div>
                <div className={`channel-state ${channel.running ? 'ok' : 'idle'}`}>
                  {channel.running
                    ? t('dashboardChannelOnline')
                    : (channel.configuredEnabled ? t('dashboardChannelOffline') : t('dashboardChannelClosed'))}
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>

      <article className="glass-card panel-card">
        <div className="panel-heading">
          <div>
            <h3>{t('dashboardRecentErrorsTitle')}</h3>
            <p>{t('dashboardRecentErrorsSubtitle')}</p>
          </div>
        </div>
        <div className="error-list">
          {runtime?.recentErrors?.length ? (
            runtime.recentErrors.slice(-5).reverse().map((item, index) => (
              <div key={`${item.time}-${index}`} className="error-item">
                <div>
                  <strong>{item.scope}</strong>
                  <p>{item.message}</p>
                </div>
                <span>{formatTime(item.time, locale)}</span>
              </div>
            ))
          ) : (
            <div className="empty-state">{t('dashboardNoRecentErrors')}</div>
          )}
        </div>
      </article>
    </section>
  );
}
