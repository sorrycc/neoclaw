import { useEffect, useRef } from 'react';
import MarkdownMessage from './MarkdownMessage';

export interface ChatMessage {
  role: string;
  content: string;
  timestamp: string;
}

export default function ChatWindow({
  messages,
  loading,
}: {
  messages: ChatMessage[];
  loading?: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  const copyMessage = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {}
  };

  return (
    <div className="chat-window-panel">
      {messages.length === 0 ? (
        <div className="chat-window-empty">发送第一条消息开始聊天。</div>
      ) : (
        messages.map((message, index) => (
          <div key={`${message.timestamp}-${index}`} className={`chat-bubble-row ${message.role === 'user' ? 'is-user' : 'is-assistant'}`}>
            <div className={`chat-bubble ${message.role === 'user' ? 'is-user' : 'is-assistant'}`}>
              <div className="chat-bubble-meta">
                <span>{message.role === 'user' ? 'You' : 'Agent'}</span>
                <span>{new Date(message.timestamp).toLocaleTimeString()}</span>
              </div>
              {message.role === 'assistant' ? <MarkdownMessage content={message.content} /> : <div className="chat-plain-text">{message.content}</div>}
              <div className="chat-bubble-actions">
                <button type="button" className="btn btn-outline chat-copy-btn" onClick={() => void copyMessage(message.content)}>
                  复制
                </button>
              </div>
            </div>
          </div>
        ))
      )}
      {loading && <div className="chat-streaming-hint">Agent 正在回复…</div>}
      <div ref={bottomRef} />
    </div>
  );
}
