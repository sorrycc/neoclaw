import { useEffect, useMemo, useState } from 'react';
import { api } from '../../../api';
import { formatTimestamp, type ConfigSnapshotMeta } from '../../../config-management';

interface RuntimeStatus {
  updatedAt: string;
  agent: {
    running: boolean;
    pid: number | null;
    startedAt?: string;
    profileDir?: string;
  };
  channels: Record<string, {
    configuredEnabled: boolean;
    running: boolean;
    lastError?: string;
  }>;
  recentErrors: Array<{
    time: string;
    scope: string;
    message: string;
  }>;
}

type CronJob = {
  enabled: boolean;
  nextRunPreview?: string;
};

type LocalSkill = {
  dirName: string;
};

interface DashboardState {
  runtime: RuntimeStatus | null;
  config: any;
  snapshots: ConfigSnapshotMeta[];
  jobs: CronJob[];
  skills: LocalSkill[];
}

function channelWarnings(config: any): string[] {
  const warnings: string[] = [];
  if (config?.channels?.telegram?.enabled && !config.channels.telegram.token) warnings.push('Telegram 缺少 token');
  if (config?.channels?.dingtalk?.enabled) {
    if (!config.channels.dingtalk.clientId || !config.channels.dingtalk.clientSecret || !config.channels.dingtalk.robotCode) {
      warnings.push('DingTalk 关键字段不完整');
    }
  }
  if (config?.channels?.feishu?.enabled) {
    if (!config.channels.feishu.appId || !config.channels.feishu.appSecret) warnings.push('Feishu 缺少 appId / appSecret');
    if (config.channels.feishu.connectionMode === 'webhook' && !config.channels.feishu.verificationToken) {
      warnings.push('Feishu webhook 缺少 verificationToken');
    }
  }
  return warnings;
}

export default function DashboardPage() {
  const [state, setState] = useState<DashboardState>({ runtime: null, config: null, snapshots: [], jobs: [], skills: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const refresh = async () => {
    try {
      setLoading(true);
      setError('');
      const [runtime, current, snapshotRes, jobRes, skillRes] = await Promise.all([
        api<RuntimeStatus>('/api/runtime-status'),
        api<{ config: any }>('/api/config/current'),
        api<{ snapshots: ConfigSnapshotMeta[] }>('/api/config/snapshots'),
        api<{ jobs: CronJob[] }>('/api/cron/jobs'),
        api<{ skills: LocalSkill[] }>('/api/skills/local'),
      ]);
      setState({
        runtime,
        config: current.config,
        snapshots: snapshotRes.snapshots || [],
        jobs: jobRes.jobs || [],
        skills: skillRes.skills || [],
      });
    } catch (err: any) {
      setError(err.message || '加载 Dashboard 失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const warnings = useMemo(() => channelWarnings(state.config), [state.config]);
  const runtime = state.runtime;
  const config = state.config;
  const recentErrors = (runtime?.recentErrors || []).slice(-3).reverse();
  const enabledJobs = state.jobs.filter((job) => job.enabled).length;
  const pausedJobs = state.jobs.length - enabledJobs;
  const nearestJob = [...state.jobs].map((job) => job.nextRunPreview).filter(Boolean).sort()[0];

  const startAgent = async () => {
    try {
      setStarting(true);
      await api('/api/agent/start', {});
      await refresh();
    } catch (err: any) {
      setError(err.message || '启动失败');
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="admin-page dashboard-page">
      <div className="section-heading glass-card">
        <div>
          <h2>Dashboard</h2>
          <p>总览当前 agent、配置、Cron、Skills 和最近错误。</p>
        </div>
        <div className="section-actions">
          <button type="button" className="btn btn-outline" onClick={refresh} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button type="button" className="btn btn-primary" onClick={startAgent} disabled={starting || !!runtime?.agent.running}>
            {runtime?.agent.running ? 'Agent 已运行' : starting ? '启动中…' : '启动 Agent'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner glass-card">{error}</div>}

      <div className="dashboard-grid">
        <article className="glass-card dashboard-card">
          <h3>Agent 状态</h3>
          <dl>
            <div><dt>运行状态</dt><dd>{runtime?.agent.running ? 'Running' : 'Stopped'}</dd></div>
            <div><dt>当前模型</dt><dd>{config?.agent?.model || '未配置'}</dd></div>
            <div><dt>Workspace</dt><dd>{config?.agent?.workspace || '未配置'}</dd></div>
            <div><dt>Profile</dt><dd>{runtime?.agent.profileDir || '未知'}</dd></div>
            <div><dt>最近更新</dt><dd>{runtime?.updatedAt ? new Date(runtime.updatedAt).toLocaleString() : '—'}</dd></div>
          </dl>
        </article>

        <article className="glass-card dashboard-card">
          <h3>配置摘要</h3>
          <dl>
            <div><dt>已配置模型</dt><dd>{config?.agent?.model || '未配置'}</dd></div>
            <div><dt>代码模型</dt><dd>{config?.agent?.codeModel || '未配置'}</dd></div>
            <div><dt>快照数量</dt><dd>{state.snapshots.length}</dd></div>
            <div><dt>最近快照</dt><dd>{state.snapshots[0] ? formatTimestamp(state.snapshots[0].createdAt, 'zh') : '暂无'}</dd></div>
          </dl>
        </article>

        <article className="glass-card dashboard-card">
          <h3>Channels 摘要</h3>
          <ul className="status-list">
            {['cli', 'telegram', 'dingtalk', 'feishu'].map((name) => {
              const enabled = config?.channels?.[name]?.enabled;
              const channelRuntime = runtime?.channels?.[name];
              return (
                <li key={name}>
                  <span>{name.toUpperCase()}</span>
                  <strong>{enabled ? (channelRuntime?.running ? '运行中' : '已启用') : '关闭'}</strong>
                </li>
              );
            })}
          </ul>
          {warnings.length > 0 && <p className="card-warning">{warnings.join('；')}</p>}
        </article>

        <article className="glass-card dashboard-card">
          <h3>Cron 摘要</h3>
          <dl>
            <div><dt>任务总数</dt><dd>{state.jobs.length}</dd></div>
            <div><dt>启用数量</dt><dd>{enabledJobs}</dd></div>
            <div><dt>暂停数量</dt><dd>{pausedJobs}</dd></div>
            <div><dt>最近下一次</dt><dd>{nearestJob ? new Date(nearestJob).toLocaleString() : '暂无'}</dd></div>
          </dl>
        </article>

        <article className="glass-card dashboard-card">
          <h3>Skills 摘要</h3>
          <dl>
            <div><dt>已安装数量</dt><dd>{state.skills.length}</dd></div>
            <div><dt>最近一个</dt><dd>{state.skills[0]?.dirName || '暂无'}</dd></div>
            <div><dt>市场入口</dt><dd>clawhub</dd></div>
            <div><dt>管理页面</dt><dd>已接入</dd></div>
          </dl>
        </article>

        <article className="glass-card dashboard-card dashboard-errors-card">
          <h3>最近错误</h3>
          {recentErrors.length === 0 ? (
            <p className="chat-window-empty">最近没有错误。</p>
          ) : (
            <div className="dashboard-error-list">
              {recentErrors.map((entry) => (
                <div key={`${entry.time}-${entry.scope}`} className="dashboard-error-item">
                  <strong>{entry.scope}</strong>
                  <span>{new Date(entry.time).toLocaleString()}</span>
                  <p>{entry.message}</p>
                </div>
              ))}
            </div>
          )}
        </article>

      </div>
    </section>
  );
}
