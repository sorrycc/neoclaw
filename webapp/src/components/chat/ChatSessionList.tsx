export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
  messageCount: number;
}

export default function ChatSessionList({
  sessions,
  activeId,
  disabled,
  onSelect,
  onCreate,
  onClear,
  onDelete,
}: {
  sessions: SessionSummary[];
  activeId: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClear: () => void;
  onDelete: () => void;
}) {
  return (
    <aside className="chat-session-list glass-card">
      <div className="chat-session-header">
        <div>
          <h3>会话列表</h3>
          <p>{sessions.length} 个已保存会话</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onCreate} disabled={disabled}>新建</button>
      </div>

      <div className="chat-session-items">
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={`chat-session-item ${session.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(session.id)}
          >
            <strong>{session.title}</strong>
            <span>{session.preview || '暂无消息'}</span>
            <small>{new Date(session.updatedAt).toLocaleString()}</small>
          </button>
        ))}
      </div>

      <div className="chat-session-actions">
        <button type="button" className="btn btn-secondary" onClick={onClear} disabled={disabled || !activeId}>清空</button>
        <button type="button" className="btn btn-outline" onClick={onDelete} disabled={disabled || !activeId}>删除</button>
      </div>
    </aside>
  );
}
