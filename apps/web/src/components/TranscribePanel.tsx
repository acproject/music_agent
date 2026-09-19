import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyzeAudio, type AnalyzeResponse } from '../api/analyze';
import { AudioCapture, TARGET_SAMPLE_RATE } from '../audio/AudioCapture';
import { ScorePlayer, type PlaybackTrack, type VoiceKind } from '../audio/scorePlayer';
import { INSTRUMENTS, instrumentLabel } from '../audio/soundfont';
import { noteName } from '../audio/pitchTrace';
import { buildArrangement, type TrackId } from '../domain/arrangement';
import { quantize, parseBeatsPerBar } from '../domain/quantize';
import {
  constantTempoMap,
  describeTempoMap,
  tempoMapFromEvents,
  type TempoAnchor,
} from '../domain/tempoMap';
import { TICKS_PER_UNIT, writeSmf } from '../domain/midiWriter';
import { recordingStore } from '../domain/recordingStore';
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

/** 两段速度旋律（120BPM 4s + 90BPM 4s），用于多段变速端到端自测。 */
function synthTwoTempo(): Float32Array {
  const sr = TARGET_SAMPLE_RATE;
  const gapSec = 0.06;
  const segments = [
    { bpm: 120, beats: 8, seconds: 4.0 },
    { bpm: 90, beats: 6, seconds: 4.0 },
  ];
  const midis = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83];
  const totalSec = segments.reduce((acc, s) => acc + s.seconds, 0);
  const pcm = new Float32Array(Math.round(totalSec * sr));
  const fade = Math.round(0.008 * sr);
  let cursor = 0;
  let noteIdx = 0;
  segments.forEach((seg) => {
    const beatSec = 60 / seg.bpm;
    const noteSec = beatSec - gapSec;
    for (let b = 0; b < seg.beats; b += 1) {
      const midi = midis[noteIdx];
      noteIdx += 1;
      const freq = 440 * 2 ** ((midi - 69) / 12);
      const start = Math.round(cursor * sr);
      const n = Math.round(noteSec * sr);
      for (let k = 0; k < n && start + k < pcm.length; k += 1) {
        const env = k < fade ? k / fade : k > n - fade ? (n - k) / fade : 1;
        pcm[start + k] = 0.3 * env * Math.sin(2 * Math.PI * freq * (k / sr));
      }
      cursor += beatSec;
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
  /** true=采用后端检测的多段 tempo map；false=用户手动选定恒定速度 */
  const [tempoAuto, setTempoAuto] = useState(true);
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
  /** 本次分析来源标签（随录音上下文提供给 AI 老师工具） */
  const sourceLabelRef = useRef('麦克风录音');
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
        pipeline: ['notes', 'midi', 'rhythm'],
      });
      setResult(resp);
      if (resp.sequence.bpm > 0) {
        setBpm(resp.sequence.bpm);
      }
      setTempoAuto(true); // 新分析默认跟随检测 map
      setPhase('done');
      // 写入共享录音上下文，供 AI 老师面板的工具调用使用
      recordingStore.set({
        pcm,
        sampleRate: TARGET_SAMPLE_RATE,
        label: sourceLabelRef.current,
        durationSec: pcm.length / TARGET_SAMPLE_RATE,
        analyzedAt: Date.now(),
      });
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
    sourceLabelRef.current = '合成测试音（C-E-G-C）';
    pcmRef.current = pcm;
    setPcmSec(pcm.length / TARGET_SAMPLE_RATE);
    await runAnalysis(pcm);
  }, [runAnalysis]);

  const handleSyntheticTwoTempo = useCallback(async () => {
    setError(null);
    setResult(null);
    const pcm = synthTwoTempo();
    sourceLabelRef.current = '合成变速测试音（120→90）';
    pcmRef.current = pcm;
    setPcmSec(pcm.length / TARGET_SAMPLE_RATE);
    await runAnalysis(pcm);
  }, [runAnalysis]);

  // M4：后端检测拍号（如 3/4）与调性（KeyEvent 扁平化在 events 中）
  const beatsPerBar = useMemo(
    () => parseBeatsPerBar(result?.sequence.time_signature),
    [result],
  );
  const detectedKey = useMemo(() => {
    const e = result?.events.find((x) => x.type === 'key');
    if (!e || typeof e.tonality !== 'string') {
      return null;
    }
    return { tonality: e.tonality, confidence: Number(e.confidence ?? 0) };
  }, [result]);

  // 检测到的多段速度（tempo 事件；无事件时用 sequence.bpm 退化为单段）
  const detectedTempoMap = useMemo<TempoAnchor[]>(
    () => tempoMapFromEvents(result?.events, result?.sequence.bpm || 100),
    [result],
  );
  // 实际生效 map：自动=检测多段；手动=下拉所选恒定速度
  const tempoMap = useMemo<TempoAnchor[]>(
    () => (tempoAuto ? detectedTempoMap : constantTempoMap(bpm)),
    [tempoAuto, detectedTempoMap, bpm],
  );
  const tempoSummary = useMemo(() => describeTempoMap(tempoMap), [tempoMap]);

  const score = useMemo(
    () => (result ? quantize(result.sequence.notes, { tempoMap, beatsPerBar }) : null),
    [result, tempoMap, beatsPerBar],
  );

  // 多轨编排：旋律 + 自动低音/和弦垫（M4 优先用后端调性，兜底本地推断）
  const arrangement = useMemo(
    () =>
      score
        ? buildArrangement(score, {
            accompaniment: accompOn,
            melodyProgram: programs.melody,
            bassProgram: programs.bass,
            padProgram: programs.pad,
            detectedKey,
          })
        : null,
    [score, accompOn, programs, detectedKey],
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
      await playerRef.current.play(playbackTracks, tempoMap, {
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
  }, [arrangement, gains, tempoMap]);

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
    const bytes = writeSmf(smfTracks, tempoMap);
    // slice() 得到自带独立 ArrayBuffer 的精确副本，满足 BlobPart 类型要求
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = tempoMap.length > 1
      ? `music_agent_arrangement_tempo${tempoMap.length}.mid`
      : `music_agent_arrangement_${tempoMap[0]?.bpm ?? bpm}bpm.mid`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [arrangement, tempoMap, bpm]);

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
        <button
          type="button"
          className="btn-secondary"
          onClick={handleSyntheticTwoTempo}
          disabled={phase === 'recording' || phase === 'analyzing'}
          title="前 4 秒 120BPM、后 4 秒 90BPM，验证多段变速检测与播放"
        >
          合成变速测试音（120→90）
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
            <select
              value={bpm}
              onChange={(e) => {
                setBpm(Number(e.target.value));
                setTempoAuto(false);
              }}
            >
              {tempoAuto && !BPM_OPTIONS.includes(bpm) && (
                <option value={bpm}>♩={bpm}（检测）</option>
              )}
              {BPM_OPTIONS.map((b) => <option key={b} value={b}>♩={b}</option>)}
            </select>
          </label>
          {!tempoAuto && (
            <button
              type="button"
              className="btn-secondary btn-mini"
              onClick={() => {
                setBpm(result?.sequence.bpm || bpm);
                setTempoAuto(true);
              }}
            >
              恢复检测速度
            </button>
          )}
          <span className="meta">
            {score?.timeSignature ?? '4/4'} 拍 · 16 分网格 ·
            {' '}
            {tempoAuto ? `自动检测 ${describeTempoMap(detectedTempoMap)}` : `手动 ♩=${bpm}`}
            {tempoAuto && detectedTempoMap.length > 1 ? `（${detectedTempoMap.length} 段变速）` : ''}
            {result?.sequence.key ? ` · ${result.sequence.key}` : ''}
          </span>
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
                自动伴奏（低音 + 和弦垫 · 调性 {arrangement?.keyName ?? '—'}）
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
              SoundFont 采样 · {tempoSummary} · {arrangement?.tracks.length ?? 1} 轨齐奏
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
