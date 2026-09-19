import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioCapture,
  describeMicError,
  enumerateMicDevices,
  micEnvironment,
  requestMicAndEnumerate,
  FRAME_BYTES,
  FRAME_SAMPLES,
  TARGET_SAMPLE_RATE,
  type MicPermissionState,
} from '../audio/AudioCapture';
import { MusicSocket, type ReadyInfo, type WsState } from '../audio/MusicSocket';
import { centsOffset, noteName, PitchTrace } from '../audio/pitchTrace';
import { recordingStore } from '../domain/recordingStore';
import PitchChart from './PitchChart';

// 目标音候选：C3(48) ~ B5(83)
const TARGET_NOTES = Array.from({ length: 36 }, (_, i) => 48 + i);
const TARGET_OPTIONS = [
  { value: 'free', label: '自由模式（不设目标音）' },
  ...TARGET_NOTES.map((m) => ({ value: String(m), label: noteName(m) })),
];

interface PitchReadout {
  hz: number;
  midi: number;
  cents: number;
  confidence: number;
}

function formatCents(cents: number): string {
  const sign = cents > 0 ? '+' : '';
  return `${sign}${cents}¢`;
}

type RunState = 'idle' | 'connecting' | 'live' | 'paused' | 'stopping' | 'error';

const MIC_STATE_TEXT: Record<MicPermissionState, string> = {
  idle: '未启动',
  requesting: '请求权限中…',
  granted: '已授权',
  denied: '权限被拒绝',
  'no-device': '无麦克风',
  'in-use': '设备被占用',
  unsupported: '浏览器不支持',
  error: '错误',
};

const WS_STATE_TEXT: Record<WsState, string> = {
  idle: '未连接',
  connecting: '连接中…',
  ready: '已连接',
  reconnecting: '断线重连中…',
  stopping: '结束中…',
  closed: '已关闭',
  failed: '连接失败',
};

function levelToDb(level: number): string {
  if (level <= 0.0005) {
    return '-∞ dB';
  }
  return `${Math.max(-60, Math.round(20 * Math.log10(level)))} dB`;
}

export default function MicPanel() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  // 麦克风 API 只在安全上下文（HTTPS / localhost）可用
  const [env] = useState(micEnvironment);
  const [probing, setProbing] = useState(false);
  const [micState, setMicState] = useState<MicPermissionState>('idle');
  const [wsState, setWsState] = useState<WsState>('idle');
  const [runState, setRunState] = useState<RunState>('idle');
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [readyInfo, setReadyInfo] = useState<ReadyInfo | null>(null);
  const [paused, setPaused] = useState(false);

  // 250ms 刷新一次的统计（高频计数放 ref，避免每帧 re-render）
  const [stats, setStats] = useState({ sent: 0, dropped: 0, events: 0, buffered: 0 });
  const [target, setTarget] = useState<number | null>(60); // 默认目标 C4
  const [readout, setReadout] = useState<PitchReadout | null>(null);

  const captureRef = useRef<AudioCapture | null>(null);
  const socketRef = useRef<MusicSocket | null>(null);
  const traceRef = useRef(new PitchTrace());
  const countersRef = useRef({ sent: 0, dropped: 0, events: 0, buffered: 0 });
  // 本地 PCM 累积：分块入队、停止时一次性合并（避免逐帧扩容拷贝）。
  // 暂停期间 worklet 不下发帧，因此缓冲天然不含暂停片段。
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const levelRef = useRef(0);
  const meterRef = useRef<HTMLDivElement | null>(null);
  const dbRef = useRef<HTMLSpanElement | null>(null);
  const rafRef = useRef(0);

  // 电平表：rAF 直接操作 DOM，不触发 React 渲染
  useEffect(() => {
    const tick = () => {
      const level = levelRef.current;
      if (meterRef.current) {
        meterRef.current.style.width = `${Math.min(100, Math.round(level * 140))}%`;
      }
      if (dbRef.current) {
        dbRef.current.textContent = levelToDb(level);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // 统计定时刷新；同时从音高轨迹读取最近 voiced 帧（陈旧帧视为无声）
  useEffect(() => {
    const timer = window.setInterval(() => {
      setStats({ ...countersRef.current });
      const trace = traceRef.current;
      const p = trace.lastVoiced();
      const now = (performance.now() - trace.startTimeMs) / 1000;
      if (p && now - p.t <= 0.25) {
        setReadout({
          hz: p.hz,
          midi: p.midi,
          cents: centsOffset(p.midi),
          confidence: p.confidence,
        });
      } else {
        setReadout(null);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  // 卸载时释放资源
  useEffect(() => {
    return () => {
      socketRef.current?.close();
      void captureRef.current?.stop();
    };
  }, []);

  const refreshDevices = useCallback(async () => {
    const list = await enumerateMicDevices();
    setDevices(list);
    if (!deviceId && list[0]?.deviceId) {
      setDeviceId(list[0].deviceId);
    }
  }, [deviceId]);

  // 主动触发一次授权弹窗；授权后 enumerateDevices 才会返回真实设备数量与名称
  const handleProbe = useCallback(async () => {
    setProbing(true);
    setNotice(null);
    try {
      const list = await requestMicAndEnumerate();
      setDevices(list);
      if (!deviceId && list[0]?.deviceId) {
        setDeviceId(list[0].deviceId);
      }
      if (list.length === 0) {
        setNotice({
          kind: 'error',
          text: '浏览器已获授权但系统未提供任何麦克风：请检查 Windows「设置 → 隐私和安全性 → 麦克风」是否允许桌面应用访问，并确认声音面板中该输入设备未被禁用。',
        });
      } else {
        setNotice({ kind: 'info', text: `检测到 ${list.length} 个麦克风设备。` });
      }
    } catch (err) {
      setNotice({ kind: 'error', text: describeMicError(err).message });
    } finally {
      setProbing(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  // 开始录音授权成功后重新枚举，设备名随之填充
  useEffect(() => {
    if (micState === 'granted') {
      void refreshDevices();
    }
  }, [micState, refreshDevices]);

  const handleStart = useCallback(async () => {
    if (runState === 'connecting' || runState === 'live' || runState === 'paused') {
      return;
    }
    setNotice(null);
    setReadyInfo(null);
    setReadout(null);
    traceRef.current.reset();
    countersRef.current = { sent: 0, dropped: 0, events: 0, buffered: 0 };
    pcmChunksRef.current = [];
    setPaused(false);
    setRunState('connecting');

    // 1) 先拿麦克风权限（拒绝则不建立 WebSocket）
    const capture = new AudioCapture({
      onPermission: (state, message) => {
        setMicState(state);
        if (state === 'denied' || state === 'no-device' || state === 'in-use' ||
          state === 'unsupported' || state === 'error') {
          setRunState('error');
          setNotice({ kind: 'error', text: message ?? MIC_STATE_TEXT[state] });
        }
      },
      onLevel: (level) => {
        levelRef.current = level;
      },
      onFrame: (pcm, level) => {
        levelRef.current = level;
        // 本地始终累积整段 PCM（与 WS 是否就绪无关，断线重连期间也不丢歌声），
        // 帧缓冲由 worklet postMessage 结构化克隆产生，每帧独立、可直接入队
        pcmChunksRef.current.push(new Float32Array(pcm));
        countersRef.current.buffered += 1;
        const sent = socketRef.current?.sendFrame(pcm) ?? false;
        if (sent) {
          countersRef.current.sent += 1;
        } else {
          countersRef.current.dropped += 1;
        }
      },
    });
    captureRef.current = capture;
    await capture.start(deviceId || undefined);

    if (!capture.running) {
      await capture.stop();
      captureRef.current = null;
      setRunState('error');
      return;
    }

    // 2) 建立实时通道（含自动重连）
    const socket = new MusicSocket({
      onState: (state) => {
        setWsState(state);
        if (state === 'ready') {
          setRunState((prev) => (prev === 'paused' ? prev : 'live'));
        } else if (state === 'reconnecting') {
          // 重连期间帧自动丢弃，电平表仍由本地麦克风驱动
        } else if (state === 'failed') {
          setRunState('error');
        }
      },
      onReady: (info) => {
        setReadyInfo(info);
        traceRef.current.reset();
        setNotice({ kind: 'info', text: `实时会话 ${info.sessionId} 已建立` });
      },
      onEvent: (event) => {
        countersRef.current.events += 1;
        if (event.type === 'pitch') {
          traceRef.current.add({
            hz: Number(event.frequency_hz ?? 0),
            midi: Number(event.midi_cents ?? 0),
            voiced: Boolean(event.voiced),
            confidence: Number(event.confidence ?? 0),
          });
        }
      },
      onServerError: (err) => {
        setNotice({
          kind: err.retriable ? 'info' : 'error',
          text: `[${err.code}] ${err.message}`,
        });
      },
    });
    socketRef.current = socket;

    try {
      await socket.start();
      setRunState('live');
    } catch (err) {
      setRunState('error');
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      await capture.stop();
      captureRef.current = null;
      // 会话未建立，丢弃握手期间缓存的零散音频
      pcmChunksRef.current = [];
      countersRef.current.buffered = 0;
    }
  }, [deviceId, runState]);

  const handlePause = useCallback(() => {
    captureRef.current?.pause();
    // WebSocket 连接保留，仅停止发送音频帧
    setPaused(true);
    setRunState('paused');
    setNotice({ kind: 'info', text: '已暂停：保留连接，停止发送音频' });
  }, []);

  const handleResume = useCallback(() => {
    captureRef.current?.resume();
    setPaused(false);
    setRunState(wsState === 'ready' ? 'live' : 'connecting');
    setNotice({ kind: 'info', text: '已恢复采集' });
  }, [wsState]);

  const handleStop = useCallback(async () => {
    setRunState('stopping');
    const capture = captureRef.current;
    const socket = socketRef.current;
    captureRef.current = null;
    socketRef.current = null;
    // 先停采集，确保合并期间不再有新帧入队
    await capture?.stop();
    setMicState('idle');
    await socket?.stop();
    setWsState('closed');

    // 分块队列一次性合并：先求总长再单次分配，每段只拷贝一次
    const chunks = pcmChunksRef.current;
    pcmChunksRef.current = [];
    const frameCount = chunks.length;
    let savedText = '';
    if (frameCount > 0) {
      const totalSamples = chunks.reduce((acc, c) => acc + c.length, 0);
      const pcm = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of chunks) {
        pcm.set(chunk, offset);
        offset += chunk.length;
      }
      const durationSec = totalSamples / TARGET_SAMPLE_RATE;
      // analyzedAt=null：尚未转谱，但 AI 老师工具可直接对这段 PCM 做分析
      recordingStore.set({
        pcm,
        sampleRate: TARGET_SAMPLE_RATE,
        label: 'M2 实时麦克风录音',
        durationSec,
        analyzedAt: null,
      });
      savedText = `，已保存 ${durationSec.toFixed(1)} 秒录音，可在下方「AI 音乐老师」直接提问分析`;
    }
    countersRef.current.buffered = 0;

    setRunState('idle');
    setPaused(false);
    levelRef.current = 0;
    setReadout(null);
    setNotice({ kind: 'info', text: `会话已结束${savedText}` });
  }, []);

  const targetDeltaCents =
    readout && target !== null ? Math.round((readout.midi - target) * 100) : null;
  const deltaClass =
    targetDeltaCents === null
      ? ''
      : Math.abs(targetDeltaCents) <= 25
        ? 'pitch-good'
        : Math.abs(targetDeltaCents) <= 50
          ? 'pitch-warn'
          : 'pitch-bad';

  const live = runState === 'live' || runState === 'paused';
  const busy = runState === 'connecting' || runState === 'stopping';

  return (
    <section className="card mic-card">
      <div className="card-head">
        <h2>M2 实时音高检测</h2>
        <span className={`tag tag-${runState === 'live' ? 'ok' : runState === 'error' ? 'bad' : 'idle'}`}>
          {runState === 'live'
            ? '● LIVE'
            : runState === 'paused'
              ? '已暂停'
              : runState === 'connecting'
                ? '连接中'
                : runState === 'stopping'
                  ? '结束中'
                  : runState === 'error'
                    ? '异常'
                    : '待机'}
        </span>
      </div>

      {(!env.secure || !env.supported) && (
        <p className="bad mic-env-warn">
          ⚠ 当前地址 {typeof window !== 'undefined' && <strong>{window.location.origin}</strong>}{' '}
          不是安全上下文，浏览器已禁用麦克风 API（即使系统声音面板里有设备也无法使用）。
          本机请改用 <strong>http://localhost:5173</strong>；平板/手机请以 <strong>https://</strong>{' '}
          开头的地址访问（设置环境变量 DEV_HTTPS=1 后重新运行启动脚本）。
        </p>
      )}

      <div className="mic-controls">
        <label className="device-select">
          <span>输入设备</span>
          <select
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            disabled={live || busy}
          >
            {devices.length === 0 && <option value="">（未检测到设备）</option>}
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `麦克风 ${d.deviceId.slice(0, 8) || ''}`}
              </option>
            ))}
          </select>
          <button type="button" className="btn-mini" onClick={refreshDevices} disabled={live || busy}>
            刷新
          </button>
        </label>

        {env.secure && env.supported && devices.length === 0 && !live && !busy && (
          <p className="notice mic-device-hint">
            尚未授权麦克风，或系统未向浏览器开放设备。
            <button type="button" className="btn-mini" onClick={handleProbe} disabled={probing}>
              {probing ? '授权检测中…' : '授权并检测设备'}
            </button>
          </p>
        )}

        <div className="btn-row">
          {!live && (
            <button type="button" onClick={handleStart} disabled={busy}>
              {runState === 'connecting' ? '启动中…' : '开始录音'}
            </button>
          )}
          {live && !paused && (
            <button type="button" className="btn-secondary" onClick={handlePause}>
              暂停
            </button>
          )}
          {live && paused && (
            <button type="button" className="btn-secondary" onClick={handleResume}>
              继续
            </button>
          )}
          {live && (
            <button type="button" className="btn-danger" onClick={handleStop}>
              停止
            </button>
          )}
        </div>
      </div>

      <div className="status-row">
        <span className="pill">
          麦克风：<strong>{MIC_STATE_TEXT[micState]}</strong>
        </span>
        <span className={`pill pill-${wsState === 'ready' ? 'ok' : wsState === 'failed' ? 'bad' : 'idle'}`}>
          通道：<strong>{WS_STATE_TEXT[wsState]}</strong>
        </span>
        {readyInfo && <span className="pill">会话：{readyInfo.sessionId}</span>}
      </div>

      <div className="meter-row">
        <span className="meter-label">电平</span>
        <div className="meter-track">
          <div ref={meterRef} className={`meter-fill ${paused ? 'meter-paused' : ''}`} />
        </div>
        <span ref={dbRef} className="meter-db">
          -∞ dB
        </span>
      </div>

      <div className="stats-row">
        <span>已发帧 <strong>{stats.sent}</strong></span>
        <span>丢弃帧 <strong className={stats.dropped > 0 ? 'warn' : ''}>{stats.dropped}</strong></span>
        <span>回流事件 <strong>{stats.events}</strong></span>
        <span>
          本地录音{' '}
          <strong>{((stats.buffered * FRAME_SAMPLES) / TARGET_SAMPLE_RATE).toFixed(1)}s</strong>
        </span>
        <span className="meta">每帧 {FRAME_BYTES}B / 40ms @ 16kHz 单声道</span>
      </div>

      {notice && (
        <p className={notice.kind === 'error' ? 'bad' : 'notice'}>
          {notice.kind === 'error' ? '⚠ ' : 'ℹ '}
          {notice.text}
        </p>
      )}

      <div className="pitch-section">
        <div className="pitch-toolbar">
          <label className="target-select">
            <span>目标音</span>
            <select
              value={target === null ? 'free' : String(target)}
              onChange={(e) =>
                setTarget(e.target.value === 'free' ? null : Number(e.target.value))
              }
            >
              {TARGET_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <div className={`pitch-readout ${readout ? '' : 'pitch-silent'}`}>
            <span className="pitch-note">{readout ? noteName(readout.midi) : '—'}</span>
            <span className="pitch-detail">
              {readout
                ? `${readout.hz.toFixed(1)} Hz · ${formatCents(readout.cents)}`
                : '未检测到乐音'}
            </span>
          </div>

          {target !== null && (
            <div className={`delta-readout ${deltaClass}`}>
              <span className="delta-label">对目标偏差</span>
              <span className="delta-value">
                {targetDeltaCents === null ? '—' : formatCents(targetDeltaCents)}
              </span>
            </div>
          )}

          <div className="conf-readout">
            <span className="delta-label">置信度</span>
            <div className="conf-track">
              <div
                className="conf-fill"
                style={{ width: `${readout ? Math.round(readout.confidence * 100) : 0}%` }}
              />
            </div>
          </div>
        </div>

        <PitchChart trace={traceRef.current} targetMidi={target} live={live} />
      </div>
    </section>
  );
}
