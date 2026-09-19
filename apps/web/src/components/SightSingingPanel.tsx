import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioCapture, micEnvironment, type MicPermissionState } from '../audio/AudioCapture';
import { MusicSocket, type WsState } from '../audio/MusicSocket';
import { noteName } from '../audio/pitchTrace';
import type { PerformanceReport, TargetNote } from '../domain/comparePerformance';
import type { FollowerSnapshot } from '../domain/scoreFollower';
import { ScoreFollower } from '../domain/scoreFollower';

// 内置视唱练习：两条 8 音旋律（2 小节，4/4）。目标时间是"相对跟练开始"的秒数，
// 预备拍偏移由 follower 的 targetOffsetSec 处理。
const EXERCISES: Record<string, { label: string; midis: number[] }> = {
  arpeggio: { label: 'C 大调主和弦琶音 C-E-G-C（上下行）', midis: [60, 64, 67, 72, 72, 67, 64, 60] },
  scale: { label: 'C 大调音阶 do-re-mi-fa-sol-la-si-do', midis: [60, 62, 64, 65, 67, 69, 71, 72] },
};
const BPM_OPTIONS = [60, 80, 100, 120];
const COUNT_IN_BEATS = 2;

type RunState = 'idle' | 'connecting' | 'live' | 'stopping' | 'error';

function buildTargets(midis: number[], bpm: number): TargetNote[] {
  const beat = 60 / bpm;
  return midis.map((midi, i) => ({
    midi,
    startSec: i * beat,
    durationSec: beat,
    measure: Math.floor(i / 4) + 1,
    noteIndex: (i % 4) + 1,
    globalIndex: i,
  }));
}

function formatCents(cents: number): string {
  return `${cents > 0 ? '+' : ''}${cents}¢`;
}

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

/** 两个预备拍的节拍器咔哒声（最后一拍高音提示进入）。 */
function playCountIn(ctx: AudioContext, beatSec: number): void {
  const t0 = ctx.currentTime + 0.08;
  for (let i = 0; i < COUNT_IN_BEATS; i += 1) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = i === COUNT_IN_BEATS - 1 ? 1320 : 880;
    const t = t0 + i * beatSec;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  }
}

export default function SightSingingPanel() {
  const [env] = useState(micEnvironment);
  const [exerciseKey, setExerciseKey] = useState('arpeggio');
  const [bpm, setBpm] = useState(80);
  const [runState, setRunState] = useState<RunState>('idle');
  const [wsState, setWsState] = useState<WsState>('idle');
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [snap, setSnap] = useState<FollowerSnapshot | null>(null);
  const [report, setReport] = useState<PerformanceReport | null>(null);

  const captureRef = useRef<AudioCapture | null>(null);
  const socketRef = useRef<MusicSocket | null>(null);
  const clickCtxRef = useRef<AudioContext | null>(null);
  const followerRef = useRef<ScoreFollower | null>(null);
  const startMsRef = useRef(0);
  const uiTimerRef = useRef(0);

  // 100ms 刷新一次快照（高频帧只进 follower，不触发 React 渲染）
  useEffect(() => {
    return () => {
      window.clearInterval(uiTimerRef.current);
      socketRef.current?.close();
      void captureRef.current?.stop();
      clickCtxRef.current?.close().catch(() => undefined);
    };
  }, []);

  const targets = buildTargets(EXERCISES[exerciseKey].midis, bpm);
  const beatSec = 60 / bpm;
  const offsetSec = COUNT_IN_BEATS * beatSec;

  const handleStart = useCallback(async () => {
    if (runState === 'connecting' || runState === 'live') {
      return;
    }
    setNotice(null);
    setReport(null);
    setSnap(null);
    setRunState('connecting');

    // 预备拍咔哒用的独立 AudioContext（在用户点击手势内创建，允许出声）
    const clickCtx = new AudioContext();
    clickCtxRef.current = clickCtx;

    const follower = new ScoreFollower(targets, {
      mode: 'sight_singing',
      targetOffsetSec: offsetSec,
    });
    followerRef.current = follower;

    const capture = new AudioCapture({
      onPermission: (state: MicPermissionState, message?: string) => {
        if (['denied', 'no-device', 'in-use', 'unsupported', 'error'].includes(state)) {
          setRunState('error');
          setNotice({ kind: 'error', text: message ?? state });
        }
      },
      onLevel: () => undefined,
      onFrame: (pcm) => {
        socketRef.current?.sendFrame(pcm);
      },
    });
    captureRef.current = capture;
    await capture.start();
    if (!capture.running) {
      await capture.stop();
      captureRef.current = null;
      setRunState('error');
      return;
    }

    const socket = new MusicSocket({
      onState: (state) => setWsState(state),
      onReady: () => undefined,
      onEvent: (event) => {
        if (event.type !== 'pitch') {
          return;
        }
        const t = (performance.now() - startMsRef.current) / 1000;
        follower.feed(
          t,
          Number(event.midi_cents ?? 0),
          Boolean(event.voiced),
          Number(event.confidence ?? 0),
        );
      },
      onServerError: (err) => {
        setNotice({ kind: err.retriable ? 'info' : 'error', text: `[${err.code}] ${err.message}` });
      },
    });
    socketRef.current = socket;

    try {
      await socket.start();
      // ready 后才开始计时：之前的音频帧尚未发送（socket 未就绪）
      startMsRef.current = performance.now();
      playCountIn(clickCtx, beatSec);
      setRunState('live');
      uiTimerRef.current = window.setInterval(() => {
        const now = (performance.now() - startMsRef.current) / 1000;
        follower.tick(now);
        setSnap(follower.snapshot());
      }, 100);
    } catch (err) {
      setRunState('error');
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      await capture.stop();
      captureRef.current = null;
      await clickCtx.close().catch(() => undefined);
      clickCtxRef.current = null;
    }
  }, [beatSec, offsetSec, runState, targets]);

  const handleStop = useCallback(async () => {
    setRunState('stopping');
    window.clearInterval(uiTimerRef.current);
    const t = (performance.now() - startMsRef.current) / 1000;
    const result = followerRef.current?.finish(t) ?? null;
    setReport(result);
    setSnap(followerRef.current?.snapshot() ?? null);
    const capture = captureRef.current;
    const socket = socketRef.current;
    captureRef.current = null;
    socketRef.current = null;
    await capture?.stop();
    await socket?.stop();
    await clickCtxRef.current?.close().catch(() => undefined);
    clickCtxRef.current = null;
    setWsState('closed');
    setRunState('idle');
  }, []);

  const live = runState === 'live';
  const busy = runState === 'connecting' || runState === 'stopping';

  // 目标音带的逐音状态
  const matchedByTarget = new Map(snap?.events.map((e) => [e.targetGlobalIndex, e]));
  const missingSet = new Set(snap?.missing.map((t) => t.globalIndex));
  const chipState = (t: TargetNote): string => {
    const ev = matchedByTarget.get(t.globalIndex);
    if (ev) {
      return ev.wrongNote ? 'sf-wrong' : 'sf-ok';
    }
    if (missingSet.has(t.globalIndex)) {
      return 'sf-missing';
    }
    if (snap && t.globalIndex === snap.currentIndex && snap.status !== 'finished') {
      return 'sf-current';
    }
    return 'sf-todo';
  };

  const currentCents = snap?.liveCentsError ?? null;
  const liveMidi = snap?.liveMidi ?? null;
  const centsClass =
    currentCents === null
      ? ''
      : Math.abs(currentCents) <= 25
        ? 'pitch-good'
        : Math.abs(currentCents) <= 50
          ? 'pitch-warn'
          : 'pitch-bad';

  return (
    <section className="card sf-card">
      <div className="card-head">
        <h2>M7 视唱跟练 · 实时 score following</h2>
        <span className={`tag tag-${live ? 'ok' : runState === 'error' ? 'bad' : 'idle'}`}>
          {live ? '● 跟练中' : busy ? '处理中' : runState === 'error' ? '异常' : '待机'}
        </span>
      </div>
      <p className="meta">
        麦克风帧流在浏览器侧实时切音并增量对齐到目标谱：当前应唱音高亮，起音即报节奏偏差，
        发声中持续报音分；错音按位置锁定、漏唱 / 多音实时统计，结束后给出综合评分。
      </p>

      {(!env.secure || !env.supported) && (
        <p className="bad">
          ⚠ 当前不是安全上下文，麦克风不可用。本机请用 <strong>http://localhost:5173</strong> 访问。
        </p>
      )}

      <div className="sf-controls">
        <label className="device-select">
          <span>练习</span>
          <select value={exerciseKey} onChange={(e) => setExerciseKey(e.target.value)} disabled={live || busy}>
            {Object.entries(EXERCISES).map(([key, ex]) => (
              <option key={key} value={key}>
                {ex.label}
              </option>
            ))}
          </select>
        </label>
        <label className="device-select">
          <span>速度</span>
          <select value={bpm} onChange={(e) => setBpm(Number(e.target.value))} disabled={live || busy}>
            {BPM_OPTIONS.map((b) => (
              <option key={b} value={b}>
                {b} BPM
              </option>
            ))}
          </select>
        </label>
        <div className="btn-row">
          {!live && (
            <button type="button" onClick={handleStart} disabled={busy}>
              {runState === 'connecting' ? '启动中…' : `开始（${COUNT_IN_BEATS} 拍预备）`}
            </button>
          )}
          {live && (
            <button type="button" className="btn-danger" onClick={handleStop}>
              结束并评分
            </button>
          )}
        </div>
      </div>

      <div className="status-row">
        <span className={`pill pill-${wsState === 'ready' ? 'ok' : wsState === 'failed' ? 'bad' : 'idle'}`}>
          通道：<strong>{wsState}</strong>
        </span>
        {live && (
          <span className="pill">
            已唱 <strong>{snap?.events.length ?? 0}</strong> · 漏{' '}
            <strong>{snap?.missing.length ?? 0}</strong> · 多{' '}
            <strong>{snap?.extra.length ?? 0}</strong>
          </span>
        )}
      </div>

      {notice && <p className={notice.kind === 'error' ? 'bad' : 'notice'}>{notice.text}</p>}

      <div className="sf-strip">
        {targets.map((t) => (
          <span key={t.globalIndex} className={`note-chip sf-chip ${chipState(t)}`}>
            {t.midi === null ? '休' : noteName(t.midi)}
            <em>
              {t.measure}-{t.noteIndex}
            </em>
          </span>
        ))}
      </div>

      {live && (
        <div className="sf-live">
          <div className="pitch-readout">
            <span className="pitch-note">
              {snap?.currentTarget && snap.currentTarget.midi !== null
                ? noteName(snap.currentTarget.midi)
                : '—'}
            </span>
            <span className="pitch-detail">当前应唱{live && snap?.status === 'waiting' ? '（预备拍）' : ''}</span>
          </div>
          <div className={`delta-readout ${centsClass}`}>
            <span className="delta-label">实时音分偏差</span>
            <span className="delta-value">{currentCents === null ? '—' : formatCents(currentCents)}</span>
          </div>
          <div className="conf-readout">
            <span className="delta-label">本音起音节奏</span>
            <span className="delta-value">
              {snap?.active ? `${snap.active.timingErrorMs > 0 ? '+' : ''}${snap.active.timingErrorMs}ms` : '—'}
            </span>
          </div>
          <div className="conf-readout">
            <span className="delta-label">听到的音</span>
            <span className="delta-value">{liveMidi !== null ? noteName(liveMidi) : '—'}</span>
          </div>
        </div>
      )}

      {report && (
        <div className="sf-summary">
          <div className="card-head">
            <h3>本次跟练报告</h3>
            <span className="tag tag-ok">综合分 {pct(report.summary.overallScore)}</span>
          </div>
          <div className="sf-metrics">
            <span>完整度 <strong>{pct(report.summary.completeness)}</strong></span>
            <span>音准合格 <strong>{pct(report.summary.pitchAccuracy)}</strong></span>
            <span>节奏合格 <strong>{pct(report.summary.timingAccuracy)}</strong></span>
            <span>
              平均音分偏差 <strong>
                {report.summary.meanPitchErrorCents === null
                  ? '—'
                  : formatCents(report.summary.meanPitchErrorCents)}
              </strong>
            </span>
            <span>
              平均节奏偏差 <strong>
                {report.summary.meanTimingErrorMs === null ? '—' : `${report.summary.meanTimingErrorMs}ms`}
              </strong>
            </span>
            <span>
              错音 <strong className={report.summary.wrongNoteCount ? 'warn' : ''}>
                {report.summary.wrongNoteCount ?? '—'}
              </strong>
            </span>
            <span>漏唱 <strong>{report.summary.missingCount}</strong></span>
            <span>多唱 <strong>{report.summary.extraCount}</strong></span>
          </div>
        </div>
      )}
    </section>
  );
}
