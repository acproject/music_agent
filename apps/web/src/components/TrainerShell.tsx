import { useMemo, useState } from 'react';
import { micEnvironment } from '../audio/AudioCapture';
import {
  BPM_BY_LEVEL,
  LEVEL_LABELS,
  generateExercise,
  type ExerciseKind,
  type ExerciseLevel,
} from '../domain/exercise';
import StaffScore from './StaffScore';
import TrainingReportView from './TrainingReportView';
import { useTrainingSession } from './useTrainingSession';

// 视唱 / 节奏训练面板的共享外壳：难度分级 + 约束随机生成（可换一条）
// → 听示范 → 2 拍预备录音 → 比较层评分 → 小节级反馈。

const LEVELS: ExerciseLevel[] = [1, 2, 3];

interface TrainerConfig {
  kind: ExerciseKind;
  title: string;
  badge: string;
  description: string;
  defaultBpm: number;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

export default function TrainerShell({ config }: { config: TrainerConfig }) {
  const [env] = useState(micEnvironment);
  const [level, setLevel] = useState<ExerciseLevel>(1);
  const [bpm, setBpm] = useState(config.defaultBpm);
  const [seed, setSeed] = useState(() => randomSeed());

  const exercise = useMemo(
    () => generateExercise(config.kind, level, { seed, bpm }),
    [config.kind, level, seed, bpm],
  );

  const session = useTrainingSession(exercise);
  const { phase } = session;
  const busy = phase === 'recording' || phase === 'analyzing';

  const phaseTag =
    phase === 'recording'
      ? { cls: 'ok', text: '● 录音中' }
      : phase === 'analyzing'
        ? { cls: 'idle', text: '分析评分中…' }
        : phase === 'done'
          ? { cls: 'ok', text: '已完成' }
          : { cls: 'idle', text: '待机' };

  return (
    <section className="card tr-card">
      <div className="card-head">
        <h2>{config.title}</h2>
        <span className={`tag tag-${phaseTag.cls}`}>{phaseTag.text}</span>
      </div>
      <p className="meta">{config.description}</p>

      {(!env.secure || !env.supported) && (
        <p className="bad">
          ⚠ 当前不是安全上下文，麦克风不可用。本机请用 <strong>http://localhost:5173</strong> 访问。
        </p>
      )}

      <div className="sf-controls">
        <label className="device-select">
          <span>难度</span>
          <select
            value={level}
            onChange={(e) => setLevel(Number(e.target.value) as ExerciseLevel)}
            disabled={busy}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABELS[l]}
              </option>
            ))}
          </select>
        </label>
        <label className="device-select">
          <span>速度</span>
          <select
            value={bpm}
            onChange={(e) => setBpm(Number(e.target.value))}
            disabled={busy}
          >
            {BPM_BY_LEVEL[level].map((b) => (
              <option key={b} value={b}>
                {b} BPM
              </option>
            ))}
          </select>
        </label>
        <div className="btn-row">
          <button
            type="button"
            onClick={() => setSeed(randomSeed())}
            disabled={busy}
          >
            换一条
          </button>
          {!session.demoPlaying && (
            <button type="button" onClick={session.playDemo} disabled={busy}>
              听示范
            </button>
          )}
          {session.demoPlaying && (
            <button type="button" onClick={session.stopDemo}>
              停止示范
            </button>
          )}
          {phase !== 'recording' && (
            <button
              type="button"
              onClick={session.startRecording}
              disabled={phase === 'analyzing'}
            >
              {phase === 'analyzing' ? '分析中…' : '开始（2 拍预备）'}
            </button>
          )}
          {phase === 'recording' && (
            <button type="button" className="btn-danger" onClick={session.stopRecording}>
              结束并评分
            </button>
          )}
        </div>
      </div>

      {phase === 'recording' && (
        <div className="status-row">
          <span className="pill">
            已录 <strong>{session.recordSec.toFixed(1)}s</strong>
          </span>
          <span className="pill pill-idle">建议戴耳机，避免预备拍外放被录入</span>
        </div>
      )}

      {session.error && <p className="bad">{session.error}</p>}

      <StaffScore score={exercise.score} />

      {session.result && <TrainingReportView exercise={exercise} result={session.result} />}

      <p className="meta tr-footnote">{config.badge}</p>
    </section>
  );
}
