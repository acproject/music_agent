// M2 WebSocket 自检：验证 hello→ready、440Hz 正弦 PCM → YIN 音高事件回流
// （voiced 且 f0≈440Hz）、stop→stopped。
// 事件路径：浏览器 → Rust 网关 → Python gRPC StreamAudio → Rust → 浏览器。

export interface WsCheckResult {
  ok: boolean;
  readyMs: number | null;
  pitchEvents: number;
  voicedCount: number;
  lastHz: number | null;
  totalMs: number;
  log: string[];
  error?: string;
}

export function runWsCheck(): Promise<WsCheckResult> {
  const started = performance.now();
  const log: string[] = [];
  let readyMs: number | null = null;
  let pitchEvents = 0;
  let voicedCount = 0;
  let lastHz: number | null = null;

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
        voicedCount,
        lastHz,
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
      let msg: {
        type?: string;
        session_id?: string;
        voiced?: boolean;
        frequency_hz?: number;
      };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      if (msg.type === 'ready') {
        readyMs = Math.round(performance.now() - started);
        log.push(`收到 ready（${readyMs}ms，会话 ${msg.session_id ?? '?'}），发送 6 帧 440Hz 正弦`);
        // 6 × 640 采样相位连续 440Hz Float32 PCM
        const SR = 16000;
        const N = 640;
        let phase = 0;
        for (let f = 0; f < 6; f += 1) {
          const frame = new Float32Array(N);
          for (let i = 0; i < N; i += 1) {
            frame[i] = 0.3 * Math.sin(phase);
            phase += (2 * Math.PI * 440) / SR;
          }
          ws.send(frame.buffer);
        }
      } else if (msg.type === 'pitch') {
        pitchEvents += 1;
        if (msg.voiced === true) {
          voicedCount += 1;
          lastHz = typeof msg.frequency_hz === 'number' ? msg.frequency_hz : null;
        }
        if (pitchEvents === 6) {
          log.push(`收到 ${pitchEvents} 个 pitch 事件（${voicedCount} voiced），发送 stop`);
          ws.send(JSON.stringify({ type: 'stop' }));
        }
      } else if (msg.type === 'stopped') {
        window.clearTimeout(timeout);
        if (voicedCount < 5 || lastHz === null || Math.abs(lastHz - 440) / 440 > 0.02) {
          finish(
            false,
            `音高检测异常：voiced=${voicedCount}/6，f0=${lastHz === null ? 'null' : lastHz.toFixed(1)}Hz`,
          );
          return;
        }
        log.push(`收到 stopped，f0=${lastHz.toFixed(1)}Hz，链路正常`);
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
