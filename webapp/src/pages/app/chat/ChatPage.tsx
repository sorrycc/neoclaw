import { useEffect, useMemo, useState } from 'react';
import { api, streamNdjson } from '../../../api';
import ChatComposer from '../../../components/chat/ChatComposer';
import ChatEmptyState from '../../../components/chat/ChatEmptyState';
import ChatSessionList, { type SessionSummary } from '../../../components/chat/ChatSessionList';
import ChatWindow, { type ChatMessage } from '../../../components/chat/ChatWindow';

interface ChatSession extends SessionSummary {
  createdAt: string;
  messages: ChatMessage[];
}

type ChatStreamEvent =
  | { type: 'delta'; delta: string }
  | { type: 'done'; message: ChatMessage; session: SessionSummary }
  | { type: 'error'; error: string };

function upsertSession(list: SessionSummary[], next: SessionSummary): SessionSummary[] {
  const filtered = list.filter((item) => item.id !== next.id);
  return [next, ...filtered];
}

export default function ChatPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session) => `${session.title} ${session.preview}`.toLowerCase().includes(query));
  }, [search, sessions]);

  const loadSession = async (id: string) => {
    const res = await api<{ session: ChatSession }>(`/api/chat/sessions/${encodeURIComponent(id)}`);
    setActiveSession(res.session);
    setSessions((prev) => upsertSession(prev, res.session));
  };

  const createSession = async () => {
    const res = await api<{ session: ChatSession }>('/api/chat/sessions', {});
    setActiveSession(res.session);
    setSessions((prev) => upsertSession(prev, res.session));
  };

  const loadSessions = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await api<{ sessions: SessionSummary[] }>('/api/chat/sessions');
      if (!res.sessions.length) {
        await createSession();
        return;
      }
      setSessions(res.sessions);
      const firstId = activeSession?.id || res.sessions[0].id;
      await loadSession(firstId);
    } catch (err: any) {
      setError(err.message || '加载会话失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSessions();
  }, []);

  const handleCreate = async () => {
    try {
      setError('');
      await createSession();
    } catch (err: any) {
      setError(err.message || '创建会话失败');
    }
  };

  const handleClear = async () => {
    if (!activeSession) return;
    try {
      const res = await api<{ session: ChatSession }>(`/api/chat/sessions/${encodeURIComponent(activeSession.id)}/clear`, {});
      setActiveSession(res.session);
      setSessions((prev) => upsertSession(prev, res.session));
    } catch (err: any) {
      setError(err.message || '清空失败');
    }
  };

  const handleDelete = async () => {
    if (!activeSession) return;
    try {
      await api(`/api/chat/sessions/${encodeURIComponent(activeSession.id)}`, { method: 'DELETE' });
      const nextSessions = sessions.filter((item) => item.id !== activeSession.id);
      setSessions(nextSessions);
      if (nextSessions[0]) {
        await loadSession(nextSessions[0].id);
      } else {
        setActiveSession(null);
        await handleCreate();
      }
    } catch (err: any) {
      setError(err.message || '删除失败');
    }
  };

  const handleSend = async (message: string) => {
    if (!activeSession) return;

    const optimisticUser: ChatMessage = {
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };
    const optimisticAssistant: ChatMessage = {
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
    };

    setError('');
    setSending(true);
    setActiveSession((prev) => prev ? { ...prev, messages: [...prev.messages, optimisticUser, optimisticAssistant] } : prev);

    try {
      await streamNdjson<ChatStreamEvent>(`/api/chat/sessions/${encodeURIComponent(activeSession.id)}/messages`, { message }, (event) => {
        if (event.type === 'error') {
          throw new Error(event.error);
        }

        if (event.type === 'delta') {
          setActiveSession((prev) => {
            if (!prev) return prev;
            const messages = [...prev.messages];
            const last = messages[messages.length - 1];
            if (last && last.role === 'assistant') {
              messages[messages.length - 1] = { ...last, content: `${last.content}${event.delta}` };
            }
            return { ...prev, messages };
          });
          return;
        }

        setSessions((prev) => upsertSession(prev, event.session));
        setActiveSession((prev) => {
          if (!prev) return prev;
          const messages = [...prev.messages];
          messages[messages.length - 1] = event.message;
          return { ...prev, ...event.session, messages };
        });
      });
    } catch (err: any) {
      const messageText = err.message || '发送失败';
      setError(messageText);
      setActiveSession((prev) => {
        if (!prev) return prev;
        const messages = [...prev.messages];
        messages[messages.length - 1] = {
          role: 'assistant',
          content: `发送失败：${messageText}`,
          timestamp: new Date().toISOString(),
        };
        return { ...prev, messages };
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="admin-page chat-page">
      <div className="section-heading glass-card">
        <div>
          <h2>Chat</h2>
          <p>正式 Web Chat，会话会持久化保存，支持搜索、复制和刷新恢复。</p>
        </div>
      </div>

      {error && <div className="error-banner glass-card">{error}</div>}

      <div className="chat-layout">
        <div className="chat-sidebar-stack">
          <div className="glass-card chat-search-box">
            <input className="form-input" placeholder="搜索会话标题或摘要" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <ChatSessionList
            sessions={filteredSessions}
            activeId={activeSession?.id || ''}
            disabled={loading || sending}
            onSelect={(id) => void loadSession(id)}
            onCreate={() => void handleCreate()}
            onClear={() => void handleClear()}
            onDelete={() => void handleDelete()}
          />
        </div>

        <div className="chat-main glass-card">
          {loading ? (
            <div className="chat-empty-state">正在加载聊天会话…</div>
          ) : !activeSession ? (
            <ChatEmptyState onCreate={() => void handleCreate()} />
          ) : (
            <>
              <div className="chat-main-header">
                <div>
                  <h3>{activeSession.title}</h3>
                  <p>{activeSession.messageCount} 条消息</p>
                </div>
              </div>
              <ChatWindow messages={activeSession.messages} loading={sending} />
              <ChatComposer disabled={sending} onSend={handleSend} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
