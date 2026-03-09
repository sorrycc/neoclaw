import { useState } from 'react';

export default function ChatComposer({
  disabled,
  onSend,
}: {
  disabled?: boolean;
  onSend: (message: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState('');

  const submit = async () => {
    const message = value.trim();
    if (!message || disabled) return;
    setValue('');
    await onSend(message);
  };

  return (
    <div className="chat-composer">
      <textarea
        className="chat-composer-input"
        placeholder="输入消息，Enter 发送，Shift+Enter 换行"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        disabled={disabled}
      />
      <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={disabled || !value.trim()}>
        发送
      </button>
    </div>
  );
}
