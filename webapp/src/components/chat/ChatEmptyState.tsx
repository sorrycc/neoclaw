export default function ChatEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="chat-empty-state">
      <h3>还没有会话</h3>
      <p>创建一个新的 Web Chat 会话，消息会持久化保存在本地。</p>
      <button type="button" className="btn btn-primary" onClick={onCreate}>新建会话</button>
    </div>
  );
}
