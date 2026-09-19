import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyzeAudio, type AnalyzeResponse } from '../api/analyze';
import { AudioCapture, TARGET_SAMPLE_RATE } from '../audio/AudioCapture';
import { ScorePlayer, type PlaybackTrack, type VoiceKind } from '../audio/scorePlayer';
import { INSTRUMENTS, instrumentLabel } from '../audio/soundfont';
import { noteName } from '../audio/pitchTrace';
import { buildArrangement, type TrackId } from '../domain/arrangement';
import { quantize } from '../domain/quantize';
import { TICKS_PER_UNIT, writeSmf } from '../domain/midiWriter';
import StaffScore from './StaffScore';
import JianpuScore from './JianpuScore';

type Phase = 'idle' | 'recording' | 'analyzing' | 'done';

const BPM_OPTIONS = [60, 70, 80, 90, 100, 110, 120, 140, 160, 180];

/** 合成 C-E-G-C 琶音（16k Float32），用于无麦克风环境下端到端自测。 */
function synthArpeggio(): Float32Array {
  const sr = TARGET_SAMPLE_RATE;
  const noteSec = 0.48;
  const gapSec = 0.06;
  const midis = [60, 64, 67, 72];
  const step = Math.round((noteSec + gapSec) * sr);
  const pcm = new Float32Array(step * midis.length);
  midis.forEach((midi, i) => {
    const freq = 440 * 2 ** ((midi - 69) / 12);
    const base = i * step;
    const n = Math.round(noteSec * sr);
    const fade = Math.round(0.008 * sr);
    for (let k = 0; k < n; k += 1) {
      const env = k < fade ? k / fade : k > n - fade ? (n - k) / fade : 1;
      pcm[base + k] = 0.3 * env * Math.sin(2 * Math.PI * freq * (k / sr));
    }
  });
  return pcm;
}

function concatChunks(chunks: ArrayBuffer[]): Float32Array {
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Float32Array(total / 4);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(new Float32Array(chunk), offset);
    offset += chunk.byteLength / 4;
  }
  return out;
}

export default function TranscribePanel() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [bpm, setBpm] = useState(100);
  const [recordSec, setRecordSec] = useState(0);
  const [pcmSec, setPcmSec] = useState(0);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [activeItem, setActiveItem] = useState<number | null>(null);

  // 多轨编排：自动伴奏开关、各轨 GM 音色 / 音量 / 当前发声方式
  const [accompOn, setAccompOn] = useState(true);
  const [programs, setPrograms] = useState<Record<TrackId, number>>({
    melody: 0, // 原声大钢琴
    bass: 32, // 原声贝斯
    pad: 48, // 弦乐合奏
  });
  const [gains, setGains] = useState<Record<TrackId, number>>({
    melody: 0.9,
    bass: 0.8,
    pad: 0.6,
  });
  const [voices, setVoices] = useState<Partial<Record<TrackId, VoiceKind | 'loading'>>>({});

  const captureRef = useRef<AudioCapture | null>(null);
  const playerRef = useRef<ScorePlayer | null>(null);
  const chunksRef = useRef<ArrayBuffer[]>([]);
  const pcmRef = useRef<Float32Array | null>(null);
  const timerRef = useRef(0);
  const startAtRef = useRef(0);

  useEffect(() => () => {
    window.clearInterval(timerRef.current);
    void captureRef.current?.stop();
    playerRef.current?.stop();
  }, []);

  const runAnalysis = useCallback(async (pcm: Float32Array) => {
    setPhase('analyzing');
    setError(null);
    try {
      const resp = await analyzeAudio(pcm, {
        sampleRate: TARGET_SAMPLE_RATE,
        channels: 1,
        pipeline: ['notes', 'midi'],
      });
      setResult(resp);
      if (resp.sequence.bpm > 0) {
        setBpm(resp.sequence.bpm);
      }
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase(pcmRef.current ? 'done' : 'idle');
    }
  }, []);

  const handleStart = useCallback(async () => {
    setError(null);
    setResult(null);
    pcmRef.current = null;
    chunksRef.current = [];
    setPcmSec(0);
    setRecordSec(0);

    const capture = new AudioCapture({
      onPermission: (state, message) => {
        if (state !== 'granted' && state !== 'requesting') {
          setError(message ?? `麦克风状态异常：${state}`);
          setPhase('idle');
        }
      },
      onFrame: (frame) => {
        // 复制一份：worklet 会复用底层 buffer
        const copy = frame.slice(0);
        chunksRef.current.push(copy);
      },
      // 离线录音不在此面板显示电平（M2 实时面板已有电平表）
      onLevel: () => undefined,
    });
    captureRef.current = capture;
    await capture.start();
    if (!capture.running) {
      await capture.stop();
      captureRef.current = null;
      return;
    }
    setPhase('recording');
    startAtRef.current = performance.now();
    timerRef.current = window.setInterval(() => {
      setRecordSec((performance.now() - startAtRef.current) / 1000);
    }, 100);
  }, []);

  const handleStop = useCallback(async () => {
    window.clearInterval(timerRef.current);
    const capture = captureRef.current;
    captureRef.current = null;
    await capture?.stop();
    const pcm = concatChunks(chunksRef.current);
    pcmRef.current = pcm;
    setPcmSec(pcm.length / TARGET_SAMPLE_RATE);
    setPhase('idle');
  }, []);

  const handleAnalyze = useCallback(() => {
    if (pcmRef.current) {
      void runAnalysis(pcmRef.current);
    }
  }, [runAnalysis]);

  const handleSynthetic = useCallback(async () => {
    setError(null);
    setResult(null);
    const pcm = synthArpeggio();
    pcmRef.current = pcm;
    setPcmSec(pcm.length / TARGET_SAMPLE_RATE);
    await runAnalysis(pcm);
  }, [runAnalysis]);

  const score = useMemo(
    () => (result ? quantize(result.sequence.notes, bpm) : null),
    [result, bpm],
  );

  // 多轨编排：旋律 + 自动低音/和弦垫（推断调性、每小节选顺阶三和弦）
  const arrangement = useMemo(
    () =>
      score
        ? buildArrangement(score, {
            accompaniment: accompOn,
            melodyProgram: programs.melody,
            bassProgram: programs.bass,
            padProgram: programs.pad,
          })
        : null,
    [score, accompOn, programs],
  );

  // 重新分析或改速度导致 score 变化时，停止旧播放
  useEffect(() => {
    playerRef.current?.stop();
    setPlaying(false);
    setActiveItem(null);
  }, [score]);

  const handlePlay = useCallback(async () => {
    if (!arrangement || arrangement.tracks[0].notes.length === 0) {
      return;
    }
    if (!playerRef.current) {
      playerRef.current = new ScorePlayer();
    }
    setError(null);
    setVoices(Object.fromEntries(arrangement.tracks.map((t) => [t.id, 'loading' as const])));
    const playbackTracks: PlaybackTrack[] = arrangement.tracks.map((t) => ({
      id: t.id,
      program: t.program,
      gain: gains[t.id] ?? 0.8,
      notes: t.notes,
    }));
    setPlaying(true);
    try {
      await playerRef.current.play(playbackTracks, bpm, {
        onActive: setActiveItem,
        onEnd: () => {
          setPlaying(false);
          setActiveItem(null);
        },
        onVoice: (trackId, kind) => {
          setVoices((v) => ({ ...v, [trackId]: kind }));
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPlaying(false);
    }
  }, [arrangement, gains, bpm]);

  const handleStopPlay = useCallback(() => {
    playerRef.current?.stop();
  }, []);

  // 多轨 MIDI（Type-1）：按当前编排（乐器 / 自动伴奏）即时生成下载
  const handleDownloadMidi = useCallback(() => {
    if (!arrangement) {
      return;
    }
    const smfTracks = arrangement.tracks.map((t, i) => ({
      name: t.name,
      program: t.program,
      channel: i === 0 ? 0 : i + 1,
      notes: t.notes.map((n) => ({
        midi: n.midi,
        startTick: n.startUnit * TICKS_PER_UNIT,
        durationTick: n.durationUnits * TICKS_PER_UNIT,
        velocity: n.velocity,
      })),
    }));
    const bytes = writeSmf(smfTracks, bpm);
    const blob = new Blob([bytes], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `music_agent_arrangement_${bpm}bpm.mid`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [arrangement, bpm]);

  const notes = result?.sequence.notes ?? [];

  return (
    <section className="card">
      <div className="card-head">
        <h2>M3 音频转谱（onset 分割 → NoteSequence → 五线谱 / 简谱）</h2>
        <span className={`tag tag-${phase === 'analyzing' || phase === 'recording' ? 'ok' : 'idle'}`}>
          {phase === 'recording' ? '● 录音中' : phase === 'analyzing' ? '分析中…' : '离线管线'}
        </span>
      </div>

      <div className="btn-row">
        {phase !== 'recording' && phase !== 'analyzing' && (
          <button type="button" onClick={handleStart}>开始录音</button>
        )}
        {phase === 'recording' && (
          <button type="button" className="btn-danger" onClick={handleStop}>停止</button>
        )}
        <button
          type="button"
          className="btn-secondary"
          onClick={handleAnalyze}
          disabled={phase === 'recording' || phase === 'analyzing' || !pcmRef.current}
        >
          转谱分析
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleSynthetic}
          disabled={phase === 'recording' || phase === 'analyzing'}
        >
          合成测试音（C-E-G-C）
        </button>
        {arrangement && (
          <button
            type="button"
            className="btn-secondary"
            onClick={handleDownloadMidi}
          >
            下载多轨 MIDI
          </button>
        )}
      </div>

      <div className="stats-row">
        {phase === 'recording' && <span>已录 <strong>{recordSec.toFixed(1)}s</strong></span>}
        {phase !== 'recording' && pcmSec > 0 && <span>音频长度 <strong>{pcmSec.toFixed(2)}s</strong></span>}
        {result && <span>检出音符 <strong>{notes.length}</strong></span>}
        {result && <span>录音ID <strong>{result.recording_id}</strong></span>}
      </div>

      {error && <p className="bad">⚠ {error}</p>}

      {notes.length > 0 && (
        <div className="quant-row">
          <label className="target-select">
            <span>量化速度</span>
            <select value={bpm} onChange={(e) => setBpm(Number(e.target.value))}>
              {BPM_OPTIONS.map((b) => <option key={b} value={b}>♩={b}</option>)}
            </select>
          </label>
          <span className="meta">4/4 拍 · 16 分网格 · M4 起替换为自动节拍检测</span>
        </div>
      )}

      {phase === 'done' && notes.length === 0 && !error && (
        <p className="notice">ℹ 未检测到明确音符：请对着麦克风唱一个单音旋律，或使用合成测试音。</p>
      )}

      {score && (
        <div className="score-block">
          <div className="mixer">
            <div className="mixer-head">
              <span>🎹 SoundFont 真实音色 · 多音轨</span>
              <label className="mixer-switch">
                <input
                  type="checkbox"
                  checked={accompOn}
                  onChange={(e) => setAccompOn(e.target.checked)}
                />
                自动伴奏（低音 + 和弦垫 · 推断调性 {arrangement?.keyName ?? '—'}）
              </label>
            </div>
            {arrangement?.tracks.map((track) => {
              const voice = voices[track.id];
              return (
                <div className="mixer-row" key={track.id}>
                  <span className="mixer-name">{track.name}</span>
                  <select
                    value={track.program}
                    onChange={(e) =>
                      setPrograms((p) => ({ ...p, [track.id]: Number(e.target.value) }))
                    }
                  >
                    {INSTRUMENTS.map((ins) => (
                      <option key={ins.program} value={ins.program}>
                        {ins.label}（GM {ins.program}）
                      </option>
                    ))}
                  </select>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={gains[track.id]}
                    onChange={(e) =>
                      setGains((g) => ({ ...g, [track.id]: Number(e.target.value) }))
                    }
                    aria-label={`${track.name}音量`}
                  />
                  <span className={`voice-badge voice-${voice ?? 'idle'}`}>
                    {voice === 'loading'
                      ? '音色加载中…'
                      : voice === 'sampled'
                        ? '采样音色'
                        : voice === 'synth'
                          ? '合成回退'
                          : instrumentLabel(track.program)}
                  </span>
                </div>
              );
            })}
            <p className="mixer-hint">首次使用某乐器会从 CDN 下载采样（约 0.3–3MB），之后由浏览器缓存。</p>
          </div>

          <div className="score-toolbar">
            <h3>五线谱</h3>
            {playing ? (
              <button type="button" className="btn-danger" onClick={handleStopPlay}>■ 停止播放</button>
            ) : (
              <button type="button" onClick={handlePlay}>▶ 播放谱面</button>
            )}
            <span className="meta">
              SoundFont 采样 · ♩={bpm} · {arrangement?.tracks.length ?? 1} 轨齐奏
              （标准音高，不含音分偏差）
            </span>
          </div>
          <StaffScore score={score} activeItem={activeItem} />
          <h3>简谱（1=C）</h3>
          <JianpuScore score={score} activeItem={activeItem} />
          <div className="note-chips">
            {notes.map((n, i) => (
              <span className="note-chip" key={i} title={`置信度 ${(n.confidence * 100).toFixed(0)}%`}>
                {noteName(n.midi)}
                <em>
                  {n.onset.toFixed(2)}s · {n.duration.toFixed(2)}s
                  {Math.abs(n.cents_offset) >= 10 ? ` · ${n.cents_offset > 0 ? '+' : ''}${Math.round(n.cents_offset)}¢` : ''}
                </em>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
