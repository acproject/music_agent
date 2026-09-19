// 麦克风采集封装：getUserMedia + AudioWorklet。
//
// 输出统一为 16kHz / 单声道 / Float32 / 40ms 一帧（640 采样 = 2560 字节），
// 采样率不支持 16k 的设备由 worklet 内部线性重采样。

export const TARGET_SAMPLE_RATE = 16_000;
export const FRAME_SAMPLES = 640;
export const FRAME_BYTES = FRAME_SAMPLES * 4;

export type MicPermissionState =
  | 'idle'
  | 'requesting'
  | 'granted'
  | 'denied'
  | 'no-device'
  | 'in-use'
  | 'unsupported'
  | 'error';

export interface AudioCaptureHandlers {
  onFrame: (pcm: ArrayBuffer, level: number) => void;
  onLevel: (level: number) => void;
  onPermission: (state: MicPermissionState, message?: string) => void;
}

/** 列出麦克风输入设备（授权前 label 可能为空字符串） */
export async function enumerateMicDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

/** 麦克风 API 运行环境：浏览器仅在安全上下文（HTTPS 或 localhost）开放该能力 */
export function micEnvironment(): { secure: boolean; supported: boolean } {
  const secure = typeof window !== 'undefined' && window.isSecureContext === true;
  const supported = Boolean(navigator.mediaDevices?.getUserMedia);
  return { secure, supported };
}

/**
 * 主动发起一次最小权限的麦克风请求以触发浏览器授权弹窗，
 * 授权后 enumerateDevices 才会返回真实数量与设备名；随后立即释放试探流。
 */
export async function requestMicAndEnumerate(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('mediaDevices unavailable', 'NotSupportedError');
  }
  const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  probe.getTracks().forEach((t) => t.stop());
  return enumerateMicDevices();
}

/** 把 getUserMedia 异常翻译成中文用户可读原因 */
export function describeMicError(err: unknown): { state: MicPermissionState; message: string } {
  const name = err instanceof DOMException ? err.name : String(err);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { state: 'denied', message: '麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试' };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { state: 'no-device', message: '未找到可用的麦克风输入设备' };
    case 'NotReadableError':
      return { state: 'in-use', message: '麦克风被其他应用占用，请关闭后重试' };
    case 'NotSupportedError':
      return {
        state: 'unsupported',
        message: '当前页面不是安全上下文（HTTPS 或 localhost），浏览器禁用了麦克风 API',
      };
    default:
      return { state: 'error', message: `麦克风初始化失败：${name}` };
  }
}

export class AudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private readonly handlers: AudioCaptureHandlers;

  constructor(handlers: AudioCaptureHandlers) {
    this.handlers = handlers;
  }

  get actualSampleRate(): number {
    return this.context?.sampleRate ?? 0;
  }

  get running(): boolean {
    return this.context?.state === 'running' && this.node !== null;
  }

  async start(deviceId?: string): Promise<void> {
    const { secure, supported } = micEnvironment();
    if (!secure || !supported) {
      this.handlers.onPermission(
        'unsupported',
        secure
          ? '当前浏览器不支持麦克风采集（getUserMedia 不可用）'
          : '当前页面不是安全上下文（HTTPS 或 localhost），浏览器禁用了麦克风 API',
      );
      return;
    }
    if (!window.AudioWorkletNode) {
      this.handlers.onPermission('unsupported', '当前浏览器不支持 AudioWorklet 实时音频');
      return;
    }

    this.handlers.onPermission('requesting');

    let mediaStream: MediaStream;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1,
          echoCancellation: false, // 教学场景保留原声，避免处理损伤音高
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
    } catch (err) {
      const { state, message } = describeMicError(err);
      this.handlers.onPermission(state, message);
      return;
    }

    this.stream = mediaStream;

    // 优先直接请求 16kHz 上下文（Chrome 会内部重采样）；
    // 不支持时退回设备原生采样率，由 worklet 重采样。
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      context = new AudioContext();
    }
    this.context = context;

    try {
      await context.audioWorklet.addModule('/worklets/recorder-worklet.js');
      const node = new AudioWorkletNode(context, 'recorder-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      });
      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type: string; pcm?: ArrayBuffer; level?: number };
        if (data.type === 'frame' && data.pcm) {
          this.handlers.onFrame(data.pcm, data.level ?? 0);
        } else if (data.type === 'level') {
          this.handlers.onLevel(data.level ?? 0);
        }
      };

      this.source = context.createMediaStreamSource(mediaStream);
      this.source.connect(node);
      this.node = node;

      if (context.state === 'suspended') {
        await context.resume();
      }

      this.handlers.onPermission('granted');
    } catch (err) {
      const { state, message } = describeMicError(err);
      this.handlers.onPermission(state, message);
      await this.stop();
    }
  }

  /** 暂停：worklet 停止下发数据，音频图保持存活 */
  pause(): void {
    this.node?.port.postMessage({ type: 'set-enabled', enabled: false });
  }

  resume(): void {
    this.node?.port.postMessage({ type: 'set-enabled', enabled: true });
    void this.context?.resume();
  }

  async stop(): Promise<void> {
    this.node?.port.postMessage({ type: 'set-enabled', enabled: false });
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.context && this.context.state !== 'closed') {
      try {
        await this.context.close();
      } catch {
        // ignore
      }
    }
    this.node = null;
    this.source = null;
    this.stream = null;
    this.context = null;
  }
}
