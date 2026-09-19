import { useCallback, useEffect, useState } from 'react';
import { fetchHealth, type HealthResponse } from './api/health';
import { runWsCheck, type WsCheckResult } from './api/wsCheck';
import { sampleNote } from './domain/sample';
import MicPanel from './components/MicPanel';
import TranscribePanel from './components/TranscribePanel';
import AgentChat from './components/AgentChat';

type Status = 'unknown' | 'up' | 'down';

function StatusDot({ status }: { status: Status }) {
  return <span className={`dot dot-${status}`} title={status} />;
}

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [apiStatus, setApiStatus] = useState<Status>('unknown');
  const [ws, setWs] = useState<WsCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    // 使用取消标志位而非 AbortController：避免 StrictMode 双挂载时
    // 中断在途请求产生 net::ERR_ABORTED 控制台噪音
    let cancelled = false;
    let timer = 0;

    const poll = async () => {
      try {
        const data = await fetchHealth();
        if (!cancelled) {
          setHealth(data);
          setApiStatus('up');
        }
      } catch {
        if (!cancelled) setApiStatus('down');
      }
      if (!cancelled) timer = window.setTimeout(poll, 3000);
    };

    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const checkWs = useCallback(async () => {
    setChecking(true);
    setWs(await runWsCheck());
    setChecking(false);
  }, []);

  const engine = health?.analysis_engine;

  return (
    <div className="page">
      <header className="hero">
        <h1>AI 音乐教学系统</h1>
        <p className="subtitle">M4 音频转谱与节奏分析 · ReAct AI 老师（工具调用闭环）· VexFlow 五线谱/简谱</p>
      </header>

      <section className="grid">
        <article className="card">
          <div className="card-head">
            <h2>Web 前端</h2>
            <StatusDot status="up" />
          </div>
          <p className="meta">React 19 + Vite + TypeScript</p>
          <p className="ok">浏览器工作台已加载</p>
        </article>

        <article className="card">
          <div className="card-head">
            <h2>Rust 核心网关</h2>
            <StatusDot status={apiStatus} />
          </div>
          <p className="meta">axum · HTTP / WebSocket · v{health?.version ?? '—'}</p>
          <p className={apiStatus === 'down' ? 'bad' : 'ok'}>
            {apiStatus === 'up'
              ? '/health 正常，SQLite 迁移已执行'
              : apiStatus === 'down'
                ? '无法连接 127.0.0.1:8080'
                : '探测中…'}
          </p>
        </article>

        <article className="card">
          <div className="card-head">
            <h2>Python 分析引擎</h2>
            <StatusDot status={engine?.connected ? 'up' : apiStatus === 'up' ? 'down' : 'unknown'} />
          </div>
          <p className="meta">
            gRPC bidi-stream · {engine?.engine ?? 'music-analysis'} v{engine?.version ?? '—'}
          </p>
          {engine?.connected ? (
            <p className="ok">StreamAudio / Ping 可达（由 Rust 网关经 gRPC 探测）</p>
          ) : (
            <p className="bad">{engine?.error ?? '等待网关上报…'}</p>
          )}
        </article>
      </section>

      <section className="card ws-card">
        <div className="card-head">
          <h2>实时音频通道自检（WebSocket）</h2>
          {ws && <StatusDot status={ws.ok ? 'up' : 'down'} />}
        </div>
        <p className="meta">hello → ready → 440Hz 正弦 PCM（6 帧）→ Python YIN pitch 事件回流 → stop</p>
        <button onClick={checkWs} disabled={checking}>
          {checking ? '自检中…' : '执行 WebSocket 自检'}
        </button>
        {ws && (
          <div className="result">
            <p className={ws.ok ? 'ok' : 'bad'}>
              {ws.ok
                ? `链路正常：ready ${ws.readyMs ?? '—'}ms · ${ws.voicedCount}/${ws.pitchEvents} voiced · f0=${ws.lastHz?.toFixed(1) ?? '—'}Hz · 总耗时 ${ws.totalMs}ms`
                : `失败：${ws.error}`}
            </p>
            <pre>{ws.log.join('\n')}</pre>
          </div>
        )}
      </section>

      <MicPanel />

      <TranscribePanel />

      <AgentChat />

      <section className="card">
        <div className="card-head">
          <h2>跨端数据契约（proto 生成）</h2>
          <span className="tag">music.v1.NoteEvent</span>
        </div>
        <p className="meta">Rust / Python / TypeScript 共用同一份 proto，以下类型由 ts-proto 生成：</p>
        <pre>{JSON.stringify(sampleNote, null, 2)}</pre>
      </section>
    </div>
  );
}
