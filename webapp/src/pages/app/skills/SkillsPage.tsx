import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../../../api';

type LocalSkill = {
  name: string;
  description: string;
  dirName: string;
  path: string;
  relativePath: string;
  updatedAt: string;
};

type LocalSkillDetail = LocalSkill & {
  content: string;
};

type MarketHealth = {
  available: boolean;
  mode: 'local' | 'npx' | 'unavailable';
  command: string;
  version?: string;
  error?: string;
};

type MarketSkill = {
  slug: string;
  displayName: string;
  summary: string;
  owner?: string;
  score?: number;
  installed?: boolean;
  latestVersion?: string;
  updatedAt?: number;
};

type InstallResult = {
  ok: boolean;
  installed: boolean;
  slug: string;
  output: string;
  error?: string;
};

function highlight(text: string, keyword: string) {
  const needle = keyword.trim();
  if (!needle) return text;
  const parts = text.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'));
  return parts.map((part, index) => part.toLowerCase() === needle.toLowerCase() ? <mark key={index}>{part}</mark> : <Fragment key={index}>{part}</Fragment>);
}

export default function SkillsPage() {
  const [tab, setTab] = useState<'local' | 'market'>('local');
  const [skills, setSkills] = useState<LocalSkill[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<LocalSkillDetail | null>(null);
  const [localKeyword, setLocalKeyword] = useState('');
  const [marketQuery, setMarketQuery] = useState('');
  const [marketResults, setMarketResults] = useState<MarketSkill[]>([]);
  const [marketHealth, setMarketHealth] = useState<MarketHealth | null>(null);
  const [installResult, setInstallResult] = useState<InstallResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [marketLoading, setMarketLoading] = useState(false);
  const [error, setError] = useState('');

  const loadLocalSkills = async (preferredName?: string) => {
    const res = await api<{ skills: LocalSkill[] }>('/api/skills/local');
    setSkills(res.skills || []);
    const target = preferredName || selectedSkill?.dirName || res.skills?.[0]?.dirName;
    if (target) {
      try {
        const detailRes = await api<{ skill: LocalSkillDetail }>(`/api/skills/${encodeURIComponent(target)}`);
        setSelectedSkill(detailRes.skill);
      } catch {
        setSelectedSkill(null);
      }
    } else {
      setSelectedSkill(null);
    }
  };

  const loadHealth = async () => {
    const res = await api<MarketHealth>('/api/skills/market/health');
    setMarketHealth(res);
  };

  const bootstrap = async () => {
    try {
      setLoading(true);
      setError('');
      await Promise.all([loadLocalSkills(), loadHealth()]);
    } catch (err: any) {
      setError(err.message || '加载 Skills 页面失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void bootstrap();
  }, []);

  const filteredSkills = useMemo(() => {
    const query = localKeyword.trim().toLowerCase();
    const list = !query
      ? skills
      : skills.filter((skill) => `${skill.name} ${skill.description} ${skill.dirName}`.toLowerCase().includes(query));
    return [...list].sort((left, right) => left.name.localeCompare(right.name));
  }, [skills, localKeyword]);

  const sortedMarketResults = useMemo(() => [...marketResults].sort((left, right) => {
    if (left.installed !== right.installed) return left.installed ? 1 : -1;
    return (right.score || 0) - (left.score || 0);
  }), [marketResults]);

  const openSkill = async (name: string) => {
    try {
      setError('');
      const res = await api<{ skill: LocalSkillDetail }>(`/api/skills/${encodeURIComponent(name)}`);
      setSelectedSkill(res.skill);
    } catch (err: any) {
      setError(err.message || '加载 Skill 详情失败');
    }
  };

  const deleteSkill = async (name: string) => {
    try {
      setError('');
      await api(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      setInstallResult({ ok: true, installed: false, slug: name, output: `已删除 ${name}` });
      await loadLocalSkills();
      if (marketResults.length) {
        setMarketResults((prev) => prev.map((item) => item.slug === name ? { ...item, installed: false } : item));
      }
    } catch (err: any) {
      setError(err.message || '删除 Skill 失败');
    }
  };

  const searchMarket = async () => {
    try {
      setMarketLoading(true);
      setError('');
      setInstallResult(null);
      const res = await api<{ results: MarketSkill[] }>('/api/skills/market/search', { query: marketQuery, limit: 8 });
      setMarketResults(res.results || []);
    } catch (err: any) {
      setError(err.message || '搜索市场失败');
    } finally {
      setMarketLoading(false);
    }
  };

  const installSkill = async (slug: string) => {
    try {
      setMarketLoading(true);
      setError('');
      const res = await api<InstallResult>('/api/skills/market/install', { name: slug });
      setInstallResult(res);
      await loadLocalSkills(slug);
      await loadHealth();
      if (marketQuery.trim()) {
        await searchMarket();
      }
    } catch (err: any) {
      const message = err.message || '安装 Skill 失败';
      setError(message);
      setInstallResult({ ok: false, installed: false, slug, output: message, error: message });
    } finally {
      setMarketLoading(false);
    }
  };

  return (
    <section className="admin-page skills-page">
      <div className="section-heading glass-card">
        <div>
          <h2>Skills</h2>
          <p>管理本地 skills，并通过 `clawhub` 市场搜索和安装。</p>
        </div>
        <div className="section-actions">
          <button type="button" className="btn btn-outline" onClick={() => void bootstrap()} disabled={loading || marketLoading}>
            {(loading || marketLoading) ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner glass-card">{error}</div>}
      {installResult && (
        <div className={`glass-card ${installResult.ok ? 'success-banner' : 'error-banner'}`}>
          <strong>{installResult.ok ? '操作成功' : '操作失败'}</strong>
          <pre className="install-log-pre">{installResult.output}</pre>
        </div>
      )}

      <div className="glass-card skills-tabbar">
        <button type="button" className={`admin-nav-item ${tab === 'local' ? 'active' : ''}`} onClick={() => setTab('local')}>已安装</button>
        <button type="button" className={`admin-nav-item ${tab === 'market' ? 'active' : ''}`} onClick={() => setTab('market')}>市场</button>
      </div>

      {tab === 'local' ? (
        <div className="skills-layout">
          <aside className="glass-card skills-local-list">
            <div className="chat-session-header">
              <div>
                <h3>本地 Skills</h3>
                <p>{skills.length} 个已安装 skill</p>
              </div>
              <button type="button" className="btn btn-outline" onClick={() => void loadLocalSkills()} disabled={loading}>刷新</button>
            </div>
            <input className="form-input" placeholder="搜索名称 / 描述 / 目录名" value={localKeyword} onChange={(event) => setLocalKeyword(event.target.value)} />
            <div className="chat-session-items">
              {filteredSkills.map((skill) => (
                <button key={skill.dirName} type="button" className={`chat-session-item ${selectedSkill?.dirName === skill.dirName ? 'active' : ''}`} onClick={() => void openSkill(skill.dirName)}>
                  <strong>{highlight(skill.name, localKeyword)}</strong>
                  <span>{highlight(skill.description || '无描述', localKeyword)}</span>
                  <small>{highlight(skill.dirName, localKeyword)}</small>
                </button>
              ))}
              {!filteredSkills.length && <div className="chat-empty-state">暂无本地 skills</div>}
            </div>
          </aside>

          <div className="glass-card skills-detail-panel">
            {!selectedSkill ? (
              <div className="chat-empty-state">选择一个 skill 查看详情。</div>
            ) : (
              <>
                <div className="skills-detail-header">
                  <div>
                    <h3>{selectedSkill.name}</h3>
                    <p>{selectedSkill.description || '无描述'}</p>
                  </div>
                  <button type="button" className="btn btn-outline" onClick={() => void deleteSkill(selectedSkill.dirName)}>
                    删除 Skill
                  </button>
                </div>
                <div className="skills-meta-grid">
                  <div><span>目录名</span><strong>{selectedSkill.dirName}</strong></div>
                  <div><span>相对路径</span><strong>{selectedSkill.relativePath}</strong></div>
                  <div><span>更新时间</span><strong>{new Date(selectedSkill.updatedAt).toLocaleString()}</strong></div>
                  <div><span>绝对路径</span><strong>{selectedSkill.path}</strong></div>
                </div>
                <pre className="skills-content-pre">{selectedSkill.content}</pre>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="skills-market-layout">
          <div className="glass-card skills-market-panel">
            <div className={`market-health-banner ${marketHealth?.available ? 'ok' : 'bad'}`}>
              <strong>clawhub {marketHealth?.available ? '可用' : '不可用'}</strong>
              <span>{marketHealth?.version ? `版本 ${marketHealth.version}` : (marketHealth?.error || '未检测到版本')}</span>
              <code>{marketHealth?.command || 'n/a'}</code>
            </div>

            <div className="skills-market-search">
              <input className="form-input" placeholder="搜索市场 skills，例如 markdown" value={marketQuery} onChange={(event) => setMarketQuery(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Enter' && marketQuery.trim()) void searchMarket();
              }} />
              <button type="button" className="btn btn-primary" onClick={() => void searchMarket()} disabled={marketLoading || !marketQuery.trim() || !marketHealth?.available}>
                {marketLoading ? '搜索中…' : '搜索'}
              </button>
            </div>

            <div className="skills-market-results">
              {sortedMarketResults.length === 0 ? (
                <div className="chat-empty-state">输入关键词后搜索 clawhub 市场。</div>
              ) : sortedMarketResults.map((skill) => (
                <article key={skill.slug} className="market-skill-card">
                  <div className="market-skill-main">
                    <div className="market-skill-title-row">
                      <h3>{skill.displayName}</h3>
                      <span className={`market-installed-badge ${skill.installed ? 'installed' : ''}`}>{skill.installed ? '已安装' : '未安装'}</span>
                    </div>
                    <p>{skill.summary || '暂无简介'}</p>
                    <div className="market-skill-meta">
                      <span>slug: {skill.slug}</span>
                      {skill.owner && <span>作者: {skill.owner}</span>}
                      {skill.latestVersion && <span>版本: {skill.latestVersion}</span>}
                      {typeof skill.score === 'number' && <span>分数: {skill.score.toFixed(3)}</span>}
                    </div>
                  </div>
                  <div className="market-skill-actions">
                    <button type="button" className="btn btn-primary" disabled={marketLoading || skill.installed || !marketHealth?.available} onClick={() => void installSkill(skill.slug)}>
                      {skill.installed ? '已安装' : '安装'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
