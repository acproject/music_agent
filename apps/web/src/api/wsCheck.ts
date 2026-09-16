// M1 WebSocket 自检：验证 hello→ready、二进制 PCM 帧→引擎 pitch 事件回流、stop→stopped。
// 事件路径：浏览器 → Rust 网关 → Python gRPC StreamAudio → Rust → 浏览器。

export interface WsCheckResult {
  ok: boolean;
  readyMs: number | null;
  pitchEvents: number;
  totalMs: number;
  log: string[];
  error?: string;
}

export function runWsCheck(): Promise<WsCheckResult> {
  const started = performance.now();
  const log: string[] = [];
  let readyMs: number | null = null;
  let pitchEvents = 0;

  return new Promise((resolve) => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/api/audio/stream`);

    const finish = (ok: boolean, error?: string) => {
      ws.onmessage = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve({
        ok,
        readyMs,
        pitchEvents,
        totalMs: Math.round(performance.now() - started),
        log,
        error,
      });
    };

    const timeout = window.setTimeout(() => finish(false, '自检超时（5s）'), 5000);

    ws.onopen = () => {
      log.push('WS 已连接，发送 hello');
      ws.send(
        JSON.stringify({ type: 'hello', sample_rate: 16000, channels: 1, mode: 'streaming' }),
      );
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: { type?: string; session_id?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      if (msg.type === 'ready') {
        readyMs = Math.round(performance.now() - started);
        log.push(`收到 ready（${readyMs}ms，会话 ${msg.session_id ?? '?'}），发送 3 帧静音 PCM`);
        // 3 × 640 采样 Float32 静音帧
        const frame = new Float32Array(640).buffer;
        ws.send(frame);
        ws.send(frame);
        ws.send(frame.slice(0));
      } else if (msg.type === 'pitch') {
        pitchEvents += 1;
        if (pitchEvents === 3) {
          log.push(`收到 ${pitchEvents} 个 pitch 事件，发送 stop`);
          ws.send(JSON.stringify({ type: 'stop' }));
        }
      } else if (msg.type === 'stopped') {
        window.clearTimeout(timeout);
        log.push('收到 stopped，链路正常');
        finish(true);
      } else if (msg.type === 'error') {
        window.clearTimeout(timeout);
        finish(false, `服务端返回 error: ${JSON.stringify(msg)}`);
      }
    };

    ws.onerror = () => {
      window.clearTimeout(timeout);
      finish(false, 'WebSocket 连接错误（Rust 网关是否已启动？）');
    };
  });
}
