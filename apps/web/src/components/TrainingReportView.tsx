import { useMemo } from 'react';
import { noteName } from '../audio/pitchTrace';
import type { Exercise } from '../domain/exercise';
import type { PerformanceEventVm } from '../domain/comparePerformance';
import type { TrainingResult } from './useTrainingSession';
import StaffScore from './StaffScore';

// 训练报告：总评指标条 + 逐音着色的谱面（ok 绿 / 抢拖拍琥珀 / 错音红）
// + 逐小节卡片（得分 badge、状态 chips、规则评语）。

const COLOR_OK = '#2e9e5b';
const COLOR_WARN = '#d98a1f';
const COLOR_BAD = '#dc4a4a';

const TIMING_TOL_MS: Record<Exercise['kind'], number> = {
  sight_singing: 120,
  rhythm: 100,
};

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function overallLabel(score: number | null): { text: string; cls: string } {
  if (score === null) {
    return { text: '暂无评分', cls: 'idle' };
  }
  if (score >= 0.9) {
    return { text: '优秀，完成得很稳', cls: 'ok' };
  }
  if (score >= 0.7) {
    return { text: '良好，再巩固薄弱小节', cls: 'warn' };
  }
  return { text: '需要多练，建议放慢速度', cls: 'bad' };
}

/** 单个配对音的状态 chip。 */
function EventChip({ event, kind }: { event: PerformanceEventVm; kind: Exercise['kind'] }) {
  let cls = 'ok';
  if (event.wrongNote) {
    cls = 'bad';
  } else if (Math.abs(event.timingErrorMs) > TIMING_TOL_MS[kind]) {
    cls = 'warn';
  }
  const timingText = `${event.timingErrorMs > 0 ? '+' : ''}${event.timingErrorMs}ms`;
  return (
    <span className={`tr-chip tr-chip-${cls}`}>
      {kind === 'rhythm' ? `第${event.noteIndex}拍` : noteName(event.actualMidi)}
      <em>
        {event.wrongNote && kind === 'sight_singing'
          ? `应 ${noteName(event.targetPitch)} · `
          : ''}
        {timingText}
      </em>
    </span>
  );
}

export default function TrainingReportView({
  exercise,
  result,
}: {
  exercise: Exercise;
  result: TrainingResult;
}) {
  const { report, measures } = result;

  const noteColors = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of report.events) {
      let color = COLOR_OK;
      if (event.wrongNote) {
        color = COLOR_BAD;
      } else if (Math.abs(event.timingErrorMs) > TIMING_TOL_MS[exercise.kind]) {
        color = COLOR_WARN;
      }
      map.set(`${event.measure}:${event.noteIndex}`, color);
    }
    return map;
  }, [report, exercise.kind]);

  const overall = overallLabel(report.summary.overallScore);

  return (
    <div className="tr-report">
      <div className="card-head">
        <h3>本次训练报告</h3>
        <span className={`tag tag-${overall.cls}`}>
          综合分 {pct(report.summary.overallScore)} · {overall.text}
        </span>
      </div>

      <div className="tr-metrics">
        <span className="tr-metric">
          完整度 <strong>{pct(report.summary.completeness)}</strong>
        </span>
        {exercise.kind === 'sight_singing' && (
          <span className="tr-metric">
            音准合格 <strong>{pct(report.summary.pitchAccuracy)}</strong>
          </span>
        )}
        <span className="tr-metric">
          节奏合格 <strong>{pct(report.summary.timingAccuracy)}</strong>
        </span>
        {exercise.kind === 'sight_singing' && (
          <span className="tr-metric">
            错音{' '}
            <strong className={report.summary.wrongNoteCount ? 'warn' : ''}>
              {report.summary.wrongNoteCount ?? '—'}
            </strong>
          </span>
        )}
        <span className="tr-metric">
          {exercise.kind === 'rhythm' ? '漏拍' : '漏唱'}{' '}
          <strong>{report.summary.missingCount}</strong>
        </span>
        <span className="tr-metric">
          多音 <strong>{report.summary.extraCount}</strong>
        </span>
      </div>

      <StaffScore score={exercise.score} noteColors={noteColors} />

      <div className="tr-measures">
        {measures.map((m) => (
          <div key={m.measure} className="tr-measure">
            <div className="tr-measure-head">
              <span>第 {m.measure} 小节</span>
              <span
                className={`tr-badge ${
                  m.score >= 0.9 ? 'tr-badge-ok' : m.score >= 0.7 ? 'tr-badge-warn' : 'tr-badge-bad'
                }`}
              >
                {Math.round(m.score * 100)}
              </span>
            </div>
            <div className="tr-chips">
              {report.events
                .filter((e) => e.measure === m.measure)
                .map((e) => (
                  <EventChip key={e.targetGlobalIndex} event={e} kind={exercise.kind} />
                ))}
              {report.missing
                .filter((t) => t.measure === m.measure)
                .map((t) => (
                  <span key={t.globalIndex} className="tr-chip tr-chip-missing">
                    {exercise.kind === 'rhythm' ? `第${t.noteIndex}拍` : `第${t.noteIndex}音`}
                    <em>漏</em>
                  </span>
                ))}
              {m.extraCount > 0 && (
                <span className="tr-chip tr-chip-missing">+{m.extraCount} 多音</span>
              )}
            </div>
            <ul className="tr-comments">
              {m.comments.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
