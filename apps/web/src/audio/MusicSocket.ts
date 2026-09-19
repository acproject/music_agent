// 实时音频 WebSocket 客户端。
//
// 职责：
//  - 与 Rust 网关建立 /api/audio/stream，完成 hello → ready 握手；
//  - 就绪后发送二进制 Float32 PCM 帧；
//  - 接收服务端扁平化的音乐事件 JSON（pitch / note / beat ...）；
//  - 非用户主动关闭时按指数退避自动重连（网络断开处理），重连后重新握手。

export type WsState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'stopping'
  | 'closed'
  | 'failed';

export interface ReadyInfo {
  sessionId: string;
  sampleRate: number;
  channels: number;
  mode: string;
}

export interface ServerError {
  code: string;
  message: string;
  retriable: boolean;
}

export interface MusicSocketHandlers {
  onState: (state: WsState) => void;
  onReady: (info: ReadyInfo) => void;
  onEvent: (event: Record<string, unknown>) => void;
  onServerError: (error: ServerError) => void;
}

const HELLO_TIMEOUT_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 5;

export class MusicSocket {
  private ws: WebSocket | null = null;
  private state: WsState = 'idle';
  private readonly handlers: MusicSocketHandlers;
  private readonly hello: Record<string, unknown>;

  private manuallyClosed = false;
  private stopping = false;
  private attempts = 0;
  private reconnectTimer = 0;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private stopResolve: (() => void) | null = null;
  private helloTimer = 0;

  constructor(handlers: MusicSocketHandlers) {
    this.handlers = handlers;
    this.hello = { type: 'hello', sample_rate: 16000, channels: 1, mode: 'streaming' };
  }

  get current(): WsState {
    return this.state;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  private setState(state: WsState) {
    this.state = state;
    this.handlers.onState(state);
  }

  /** 首次连接并完成握手；失败（含重连耗尽）时 reject */
  async start(): Promise<void> {
    this.manuallyClosed = false;
    return this.connectWithHandshake('connecting');
  }

  private connectWithHandshake(state: WsState): Promise<void> {
    this.setState(state);
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;

      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${window.location.host}/api/audio/stream`);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      this.helloTimer = window.setTimeout(() => {
        if (this.state !== 'ready') {
          ws.close();
          this.failHandshake(new Error('握手超时：服务端未返回 ready'));
        }
      }, HELLO_TIMEOUT_MS);

      ws.onopen = () => {
        ws.send(JSON.stringify(this.hello));
      };

      ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev);

      ws.onclose = () => this.handleClose();

      ws.onerror = () => {
        // 具体错误由 onclose 流程统一处理，这里只兜底失败握手
        if (this.state === 'connecting' || this.state === 'reconnecting') {
          // 等待 close 事件，避免重复决策
        }
      };
    });
  }

  private handleMessage(ev: MessageEvent) {
    if (typeof ev.data !== 'string') {
      return; // M1 服务端只推送文本 JSON
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(msg.type ?? '');

    if (type === 'ready') {
      window.clearTimeout(this.helloTimer);
      const info: ReadyInfo = {
        sessionId: String(msg.session_id ?? ''),
        sampleRate: Number(msg.sample_rate ?? 16000),
        channels: Number(msg.channels ?? 1),
        mode: String(msg.mode ?? 'streaming'),
      };
      this.attempts = 0;
      this.setState('ready');
      this.handlers.onReady(info);
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }

    if (type === 'stopped') {
      this.stopResolve?.();
      this.stopResolve = null;
      return;
    }

    if (type === 'pong') {
      return;
    }

    if (type === 'error') {
      this.handlers.onServerError({
        code: String(msg.code ?? 'unknown'),
        message: String(msg.message ?? '未知错误'),
        retriable: Boolean(msg.retriable),
      });
      return;
    }

    // pitch / note / beat / chord / tempo / key / measure / performance ...
    this.handlers.onEvent(msg);
  }

  private handleClose() {
    window.clearTimeout(this.helloTimer);

    // 握手阶段失败
    if (this.state === 'connecting' || this.state === 'reconnecting') {
      this.failHandshake(new Error('无法连接实时音频服务（Rust 网关是否已启动？）'));
      return;
    }

    if (this.manuallyClosed || this.stopping) {
      this.setState('closed');
      return;
    }

    // 运行中断线：自动重连，重连成功后服务端会分配新的 session_id
    if (this.attempts < MAX_RECONNECT_ATTEMPTS) {
      this.attempts += 1;
      const delayMs = Math.min(500 * 2 ** (this.attempts - 1), 8000);
      this.setState('reconnecting');
      this.handlers.onServerError({
        code: 'disconnected',
        message: `连接断开，${Math.round(delayMs / 100) / 10}s 后第 ${this.attempts} 次重连…`,
        retriable: true,
      });
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => {
        this.connectWithHandshake('reconnecting').catch(() => {
          /* 失败信息已在 failHandshake 中上报 */
        });
      }, delayMs);
    } else {
      this.setState('failed');
      this.handlers.onServerError({
        code: 'reconnect_failed',
        message: '多次重连失败，请检查网络后手动重连',
        retriable: false,
      });
    }
  }

  private failHandshake(err: Error) {
    this.readyReject?.(err);
    this.readyResolve = null;
    this.readyReject = null;

    if (this.attempts < MAX_RECONNECT_ATTEMPTS && !this.manuallyClosed) {
      this.attempts += 1;
      const delayMs = Math.min(500 * 2 ** (this.attempts - 1), 8000);
      this.setState('reconnecting');
      this.handlers.onServerError({
        code: 'connect_failed',
        message: `${err.message}，${Math.round(delayMs / 100) / 10}s 后重试（${this.attempts}/${MAX_RECONNECT_ATTEMPTS}）`,
        retriable: true,
      });
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => {
        this.connectWithHandshake('reconnecting').catch(() => undefined);
      }, delayMs);
    } else {
      this.setState('failed');
    }
  }

  /** 发送一帧 PCM；仅 ready 状态下发送，其余状态丢帧（由调用方计数） */
  sendFrame(pcm: ArrayBuffer): boolean {
    if (this.state !== 'ready' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(pcm);
    return true;
  }

  /** 通知服务端结束本次会话，等待 stopped 回执后关闭 */
  async stop(): Promise<void> {
    this.stopping = true;
    // 主动结束属于终态关闭：抑制 onclose 里的自动重连（close 的事件回调是异步的，
    // 不能依赖 stopping 标志在回调触发前仍然为 true）
    this.manuallyClosed = true;
    window.clearTimeout(this.reconnectTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        this.stopResolve = resolve;
        this.ws?.send(JSON.stringify({ type: 'stop' }));
        window.setTimeout(resolve, 1500); // 兜底超时
      });
    }
    this.ws?.close();
    this.stopping = false;
    this.setState('closed');
  }

  /** 放弃当前会话（不再自动重连），用于用户手动关闭 */
  close(): void {
    this.manuallyClosed = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.helloTimer);
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.setState('closed');
  }
}
