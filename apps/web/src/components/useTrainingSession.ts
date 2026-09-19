import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioCapture, type MicPermissionState } from '../audio/AudioCapture';
import { playCountIn } from '../audio/metronome';
import { analyzeAudio } from '../api/analyze';
import { comparePerformance, type PerformanceReport } from '../domain/comparePerformance';
import type { Exercise } from '../domain/exercise';
import { buildMeasureFeedback, type MeasureFeedback } from '../domain/measureFeedback';
import type { PlaybackTrack } from '../audio/scorePlayer';
import { ScorePlayer } from '../audio/scorePlayer';
import type { ArrangementNote } from '../domain/arrangement';

// 两个训练面板共享的会话编排：
//   授权麦克风 → 2 拍预备（预备拍期间不攒帧）→ 录音攒 PCM → 停止后送 notes 检测
//   → comparePerformance 按模式评分 → buildMeasureFeedback 小节级聚合。
// 全链路离线、规则化，不依赖 LLM。

const TARGET_SAMPLE_RATE = 16_000;
const COUNT_IN_BEATS = 2;

export type TrainingPhase = 'idle' | 'recording' | 'analyzing' | 'done';

export interface TrainingResult {
  report: PerformanceReport;
  measures: MeasureFeedback[];
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

/** 练习谱 → 单轨钢琴示范。 */
function demoTrack(exercise: Exercise): PlaybackTrack {
  const notes: ArrangementNote[] = [];
  exercise.score.measures.forEach((measure) => {
    let offsetUnits = 0;
    measure.items.forEach((item) => {
      if (item.kind === 'note') {
        notes.push({
          globalIndex: notes.length,
          startUnit: measure.startUnit + offsetUnits,
          durationUnits: item.units,
          midi: item.midi ?? 60,
          velocity: 90,
        });
      }
      offsetUnits += item.units;
    });
  });
  return { id: 'demo', program: 0, gain: 0.9, notes };
}

export function useTrainingSession(exercise: Exercise | null) {
  const [phase, setPhase] = useState<TrainingPhase>('idle');
  const [recordSec, setRecordSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TrainingResult | null>(null);
  const [demoPlaying, setDemoPlaying] = useState(false);

  const captureRef = useRef<AudioCapture | null>(null);
  const clickCtxRef = useRef<AudioContext | null>(null);
  const playerRef = useRef<ScorePlayer | null>(null);
  const chunksRef = useRef<ArrayBuffer[]>([]);
  const entryAtRef = useRef(0);
  const timerRef = useRef(0);

  // exercise 变化（换一条 / 改难度）时中止进行中的会话
  useEffect(() => {
    window.clearInterval(timerRef.current);
    void captureRef.current?.stop();
    captureRef.current = null;
    void clickCtxRef.current?.close().catch(() => undefined);
    clickCtxRef.current = null;
    playerRef.current?.stop();
    chunksRef.current = [];
    setPhase('idle');
    setRecordSec(0);
    setError(null);
    setResult(null);
    setDemoPlaying(false);
  }, [exercise]);

  // 卸载清理
  useEffect(() => () => {
    window.clearInterval(timerRef.current);
    void captureRef.current?.stop();
    playerRef.current?.stop();
    void clickCtxRef.current?.close().catch(() => undefined);
  }, []);

  const startRecording = useCallback(async () => {
    if (!exercise || phase === 'recording' || phase === 'analyzing') {
      return;
    }
    setError(null);
    setResult(null);
    chunksRef.current = [];
    setRecordSec(0);

    const capture = new AudioCapture({
      onPermission: (state: MicPermissionState, message?: string) => {
        if (!['granted', 'requesting'].includes(state)) {
          setError(message ?? `麦克风状态异常：${state}`);
          setPhase('idle');
        }
      },
      onLevel: () => undefined,
      onFrame: (pcm) => {
        // 预备拍期间的帧（咔哒声）丢弃，PCM 时间原点即正式进入小节
        if (performance.now() < entryAtRef.current) {
          return;
        }
        chunksRef.current.push(pcm.slice(0));
      },
    });
    captureRef.current = capture;
    await capture.start();
    if (!capture.running) {
      await capture.stop();
      captureRef.current = null;
      return;
    }

    // 授权后再放预备拍，保证 entry 时刻不被权限弹窗拖延
    const clickCtx = new AudioContext();
    clickCtxRef.current = clickCtx;
    const entryDelaySec = playCountIn(clickCtx, exercise.bpm, COUNT_IN_BEATS);
    entryAtRef.current = performance.now() + entryDelaySec * 1000;

    setPhase('recording');
    timerRef.current = window.setInterval(() => {
      setRecordSec(Math.max(0, (performance.now() - entryAtRef.current) / 1000));
    }, 100);
  }, [exercise, phase]);

  const stopRecording = useCallback(async () => {
    if (!exercise || phase !== 'recording') {
      return;
    }
    window.clearInterval(timerRef.current);
    const capture = captureRef.current;
    captureRef.current = null;
    await capture?.stop();
    await clickCtxRef.current?.close().catch(() => undefined);
    clickCtxRef.current = null;

    setPhase('analyzing');
    try {
      const pcm = concatChunks(chunksRef.current);
      const resp = await analyzeAudio(pcm, {
        sampleRate: TARGET_SAMPLE_RATE,
        channels: 1,
        pipeline: ['notes'],
      });
      const report = comparePerformance(exercise.targets, resp.sequence.notes, {
        mode: exercise.kind,
      });
      const measures = buildMeasureFeedback(report, {
        offsetSec: 0,
        tempoMap: exercise.score.tempoMap,
        measuresCount: exercise.score.measures.length,
      });
      setResult({ report, measures });
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }, [exercise, phase]);

  const playDemo = useCallback(async () => {
    if (!exercise || phase === 'recording' || phase === 'analyzing' || demoPlaying) {
      return;
    }
    if (!playerRef.current) {
      playerRef.current = new ScorePlayer();
    }
    setError(null);
    setDemoPlaying(true);
    try {
      await playerRef.current.play([demoTrack(exercise)], exercise.score.tempoMap, {
        onActive: () => undefined,
        onEnd: () => {
          setDemoPlaying(false);
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDemoPlaying(false);
    }
  }, [exercise, phase, demoPlaying]);

  const stopDemo = useCallback(() => {
    playerRef.current?.stop();
    setDemoPlaying(false);
  }, []);

  return {
    phase,
    recordSec,
    error,
    result,
    demoPlaying,
    startRecording,
    stopRecording,
    playDemo,
    stopDemo,
  };
}
