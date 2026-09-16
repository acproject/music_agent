// 实时音高轨迹环形缓冲：保存最近 WINDOW_SEC 秒的 PitchFrame，
// 供 Canvas 以 rAF 方式滚动绘制（不触发 React 渲染）。

export interface PitchPoint {
  /** 相对会话开始的秒数（浏览器到达时钟） */
  t: number;
  /** 连续 MIDI 音高（含小数） */
  midi: number;
  /** 基频 Hz */
  hz: number;
  voiced: boolean;
  confidence: number;
}

export const WINDOW_SEC = 5;
const MAX_POINTS = Math.ceil(WINDOW_SEC * 50) + 10; // 25fps 实际只会用一半

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI 音号 → 音名，如 60 -> "C4"，69.5 -> "A4 +50¢" */
export function noteName(midi: number): string {
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

/** 相对最近半音的音分偏差，如 59.7 -> -30 */
export function centsOffset(midi: number): number {
  return Math.round((midi - Math.round(midi)) * 100);
}

export class PitchTrace {
  private points: PitchPoint[] = [];
  private start = performance.now();

  reset(): void {
    this.points = [];
    this.start = performance.now();
  }

  add(p: Omit<PitchPoint, 't'>): void {
    this.points.push({ ...p, t: (performance.now() - this.start) / 1000 });
    if (this.points.length > MAX_POINTS) {
      this.points.splice(0, this.points.length - MAX_POINTS);
    }
  }

  /** 返回当前窗口内的点（调用方不应修改） */
  snapshot(): PitchPoint[] {
    return this.points;
  }

  /** 最近一个 voiced 点（无则 null） */
  lastVoiced(): PitchPoint | null {
    for (let i = this.points.length - 1; i >= 0; i -= 1) {
      if (this.points[i].voiced) {
        return this.points[i];
      }
    }
    return null;
  }

  get startTimeMs(): number {
    return this.start;
  }
}
