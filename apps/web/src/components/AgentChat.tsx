import { useCallback, useEffect, useRef, useState } from 'react';
import {
  postChat,
  recordingFromSnapshot,
  type ChatMessageDto,
} from '../api/agent';
import { useRecording } from '../domain/recordingStore';

interface UIMessage extends ChatMessageDto {
  id: number;
}

const WELCOME =
  '你好，我是你的 AI 音乐老师。先在上方录音或用合成测试音完成一次转谱，' +
  '然后可以问我：音准怎么样、节奏稳不稳、该怎么练习。我的所有分析结论都来自分析工具，不会凭空猜测。';

const QUICK_PROMPTS = [
  '分析这段录音的音准',
  '分析这段录音的节奏与速度',
  '根据转谱结果给出练习建议',
];

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) {
    return '';
  }
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}分${s.toString().padStart(2, '0')}秒` : `${s.toFixed(1)}秒`;
}

export default function AgentChat() {
  const recording = useRecording();
  const [messages, setMessages] = useState<UIMessage[]>([
    { id: 0, role: 'assistant', content: WELCOME },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const nextIdRef = useRef(1);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 新消息后滚动到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, busy]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy) {
        return;
      }
      setError(null);
      setNotice(null);

      const { recording: payload, truncated } = recordingFromSnapshot(recording);
      if (truncated) {
        setNotice('录音过长（超过约 4 分 41 秒），本次未携带录音给 AI；请分段录音后再分析。');
      }

      const userMsg: UIMessage = { id: nextIdRef.current++, role: 'user', content };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      setInput('');
      setBusy(true);
      try {
        const resp = await postChat(
          nextMessages.map(({ role, content: c }) => ({ role, content: c })),
          payload,
        );
        setMessages((prev) => [
          ...prev,
          { id: nextIdRef.current++, role: 'assistant', content: resp.reply },
        ]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, messages, recording],
  );

  const hasRecording = Boolean(recording.pcm);

  return (
    <section className="card agent-card">
      <div className="card-head">
        <h2>AI 音乐老师</h2>
        <span className={`tag tag-${busy ? 'ok' : 'idle'}`}>
          {busy ? '● 分析中' : 'ReAct · 工具调用'}
        </span>
      </div>

      <div className="agent-context">
        {hasRecording ? (
          <span className="pill pill-ok">
            当前录音：<strong>{recording.label || '未命名录音'}</strong>
            {recording.durationSec > 0 && ` · ${formatDuration(recording.durationSec)}`}
          </span>
        ) : (
          <span className="pill">
            未携带录音：可先在上方完成一次转谱；也可以直接问乐理问题
          </span>
        )}
      </div>

      <div className="agent-messages" ref={listRef}>
        {messages.map((m) => (
          <div key={m.id} className={`agent-msg agent-msg-${m.role}`}>
            <span className="agent-msg-role">{m.role === 'user' ? '我' : 'AI 老师'}</span>
            <p className="agent-msg-body">{m.content}</p>
          </div>
        ))}
        {busy && (
          <div className="agent-msg agent-msg-assistant">
            <span className="agent-msg-role">AI 老师</span>
            <p className="agent-msg-body agent-typing">正在调用分析工具…</p>
          </div>
        )}
      </div>

      {notice && <p className="notice">ℹ {notice}</p>}
      {error && <p className="bad">⚠ {error}</p>}

      <div className="agent-quick">
        {QUICK_PROMPTS.map((q) => (
          <button
            key={q}
            type="button"
            className="btn-secondary btn-mini"
            disabled={busy}
            onClick={() => void send(q)}
          >
            {q}
          </button>
        ))}
      </div>

      <div className="agent-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(input);
            }
          }}
          placeholder="向 AI 老师提问……（Enter 发送，Shift+Enter 换行）"
          rows={2}
          disabled={busy}
        />
        <button type="button" onClick={() => void send(input)} disabled={busy || !input.trim()}>
          {busy ? '分析中…' : '发送'}
        </button>
      </div>
    </section>
  );
}
