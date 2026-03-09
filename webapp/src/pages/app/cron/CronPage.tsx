import { useEffect, useMemo, useState } from 'react';
import { api } from '../../../api';

type CronJob = {
  id: string;
  type: 'every' | 'at' | 'cron';
  schedule: string | number;
  payload: { message: string; channel: string; chatId: string };
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  nextRunPreview?: string;
};

type FormState = {
  type: 'every' | 'at' | 'cron';
  everySeconds: string;
  atTime: string;
  cronExpr: string;
  message: string;
  channel: string;
  chatId: string;
};

const EMPTY_FORM: FormState = {
  type: 'every',
  everySeconds: '3600',
  atTime: '',
  cronExpr: '0 9 * * 1-5',
  message: '',
  channel: 'cli',
  chatId: 'cli',
};

export default function CronPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'paused'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'every' | 'at' | 'cron'>('all');
  const [keyword, setKeyword] = useState('');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const refresh = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await api<{ jobs: CronJob[] }>('/api/cron/jobs');
      setJobs(res.jobs || []);
    } catch (err: any) {
      setError(err.message || '加载 Cron 任务失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filteredJobs = useMemo(() => jobs.filter((job) => {
    if (statusFilter === 'enabled' && !job.enabled) return false;
    if (statusFilter === 'paused' && job.enabled) return false;
    if (typeFilter !== 'all' && job.type !== typeFilter) return false;
    if (keyword.trim()) {
      const haystack = `${job.payload.message} ${job.payload.channel} ${job.payload.chatId}`.toLowerCase();
      if (!haystack.includes(keyword.trim().toLowerCase())) return false;
    }
    return true;
  }), [jobs, keyword, statusFilter, typeFilter]);

  const submit = async () => {
    try {
      setSubmitting(true);
      setError('');
      setSuccess('');
      const schedule = form.type === 'every'
        ? Number(form.everySeconds)
        : form.type === 'at'
          ? new Date(form.atTime).toISOString()
          : form.cronExpr.trim();
      await api('/api/cron/jobs', {
        type: form.type,
        schedule,
        message: form.message,
        channel: form.channel,
        chatId: form.chatId,
      });
      setForm(EMPTY_FORM);
      setSuccess('Cron 任务已创建');
      await refresh();
    } catch (err: any) {
      setError(err.message || '创建 Cron 任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  const mutateJob = async (job: CronJob, action: 'pause' | 'resume' | 'delete') => {
    try {
      setError('');
      setSuccess('');
      if (action === 'delete') {
        await api(`/api/cron/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      } else {
        await api(`/api/cron/jobs/${encodeURIComponent(job.id)}/${action}`, {});
      }
      setSuccess(`任务 ${job.id} 已${action === 'pause' ? '暂停' : action === 'resume' ? '恢复' : '删除'}`);
      await refresh();
    } catch (err: any) {
      setError(err.message || 'Cron 操作失败');
    }
  };

  const formReady = Boolean(
    form.message.trim()
    && form.channel.trim()
    && form.chatId.trim()
    && (
      (form.type === 'every' && Number(form.everySeconds) > 0)
      || (form.type === 'at' && form.atTime)
      || (form.type === 'cron' && form.cronExpr.trim())
    )
  );

  return (
    <section className="admin-page cron-page">
      <div className="section-heading glass-card">
        <div>
          <h2>Cron</h2>
          <p>管理定时任务，支持 list / add / pause / resume / remove。</p>
        </div>
        <div className="section-actions">
          <button type="button" className="btn btn-outline" onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner glass-card">{error}</div>}
      {success && <div className="success-banner glass-card">{success}</div>}

      <div className="cron-layout">
        <div className="glass-card cron-create-panel">
          <h3>新建任务</h3>
          <div className="cron-form-grid">
            <div className="form-group">
              <label className="form-label">类型</label>
              <select className="form-select" value={form.type} onChange={(event) => setForm((prev) => ({ ...prev, type: event.target.value as FormState['type'] }))}>
                <option value="every">every</option>
                <option value="at">at</option>
                <option value="cron">cron</option>
              </select>
            </div>

            {form.type === 'every' && (
              <div className="form-group">
                <label className="form-label">间隔秒数</label>
                <input className="form-input" value={form.everySeconds} onChange={(event) => setForm((prev) => ({ ...prev, everySeconds: event.target.value }))} />
              </div>
            )}

            {form.type === 'at' && (
              <div className="form-group">
                <label className="form-label">执行时间</label>
                <input type="datetime-local" className="form-input" value={form.atTime} onChange={(event) => setForm((prev) => ({ ...prev, atTime: event.target.value }))} />
              </div>
            )}

            {form.type === 'cron' && (
              <div className="form-group">
                <label className="form-label">Cron 表达式</label>
                <input className="form-input" value={form.cronExpr} onChange={(event) => setForm((prev) => ({ ...prev, cronExpr: event.target.value }))} />
              </div>
            )}

            <div className="form-group cron-form-span-2">
              <label className="form-label">消息</label>
              <textarea className="chat-composer-input" value={form.message} onChange={(event) => setForm((prev) => ({ ...prev, message: event.target.value }))} />
            </div>

            <div className="form-group">
              <label className="form-label">Channel</label>
              <input className="form-input" value={form.channel} onChange={(event) => setForm((prev) => ({ ...prev, channel: event.target.value }))} />
            </div>

            <div className="form-group">
              <label className="form-label">Chat ID</label>
              <input className="form-input" value={form.chatId} onChange={(event) => setForm((prev) => ({ ...prev, chatId: event.target.value }))} />
            </div>
          </div>

          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={submitting || !formReady}>
            {submitting ? '创建中…' : '创建任务'}
          </button>
        </div>

        <div className="glass-card cron-list-panel">
          <div className="cron-filter-bar">
            <select className="form-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">全部状态</option>
              <option value="enabled">仅启用</option>
              <option value="paused">仅暂停</option>
            </select>
            <select className="form-select" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as typeof typeFilter)}>
              <option value="all">全部类型</option>
              <option value="every">every</option>
              <option value="at">at</option>
              <option value="cron">cron</option>
            </select>
            <input className="form-input" placeholder="搜索 message / channel / chatId" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
          </div>

          <div className="cron-table-wrap">
            <table className="cron-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Type</th>
                  <th>Schedule</th>
                  <th>Status</th>
                  <th>Next Run</th>
                  <th>Message</th>
                  <th>Channel</th>
                  <th>Chat ID</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="cron-empty-row">{loading ? '加载中…' : '暂无任务'}</td>
                  </tr>
                ) : filteredJobs.map((job) => (
                  <tr key={job.id}>
                    <td>{job.id}</td>
                    <td>{job.type}</td>
                    <td><code>{String(job.schedule)}</code></td>
                    <td>{job.enabled ? '启用' : '暂停'}</td>
                    <td>{job.nextRunPreview ? new Date(job.nextRunPreview).toLocaleString() : '—'}</td>
                    <td className="cron-message-cell">{job.payload.message}</td>
                    <td>{job.payload.channel}</td>
                    <td>{job.payload.chatId}</td>
                    <td>
                      <div className="cron-actions">
                        {job.enabled ? (
                          <button type="button" className="btn btn-secondary" onClick={() => void mutateJob(job, 'pause')}>暂停</button>
                        ) : (
                          <button type="button" className="btn btn-secondary" onClick={() => void mutateJob(job, 'resume')}>恢复</button>
                        )}
                        <button type="button" className="btn btn-outline" onClick={() => void mutateJob(job, 'delete')}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
