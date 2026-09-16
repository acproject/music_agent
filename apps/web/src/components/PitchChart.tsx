import { useEffect, useRef } from 'react';
import { WINDOW_SEC, noteName, type PitchTrace } from '../audio/pitchTrace';

interface PitchChartProps {
  trace: PitchTrace;
  /** 目标音 MIDI（null = 自由模式，不画目标线/偏差着色） */
  targetMidi: number | null;
  /** 是否处于活动会话（影响空态文案） */
  live: boolean;
}

const COLORS = {
  bg: '#141b2b',
  grid: '#26324c',
  gridC: '#34425f',
  text: '#7d8aa3',
  target: '#f5c451',
  free: '#5bb8ff',
  good: '#3ddc97',
  warn: '#f5c451',
  bad: '#ff6b6b',
};

function deltaColor(deltaCents: number): string {
  const abs = Math.abs(deltaCents);
  if (abs <= 25) {
    return COLORS.good;
  }
  if (abs <= 50) {
    return COLORS.warn;
  }
  return COLORS.bad;
}

export default function PitchChart({ trace, targetMidi, live }: PitchChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const targetRef = useRef<number | null>(targetMidi);
  const liveRef = useRef(live);
  targetRef.current = targetMidi;
  liveRef.current = live;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    let raf = 0;
    let cssW = 0;
    let cssH = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cssW = rect.width;
      cssH = rect.height;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const PAD_L = 44;
    const PAD_R = 12;
    const PAD_T = 10;
    const PAD_B = 18;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (cssW === 0) {
        return;
      }

      const plotW = cssW - PAD_L - PAD_R;
      const plotH = cssH - PAD_T - PAD_B;
      const target = targetRef.current;

      // y 轴范围：目标音 ±12 半音；自由模式固定 C3..C6
      const yLow = target !== null ? target - 12 : 48;
      const yHigh = target !== null ? target + 12 : 84;
      const span = yHigh - yLow;

      const yOf = (midi: number) =>
        PAD_T + ((yHigh - midi) / span) * plotH;

      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, cssW, cssH);

      // ---- 半音网格 ----
      ctx.font = '10px ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      for (let m = Math.ceil(yLow); m <= Math.floor(yHigh); m += 1) {
        const isC = m % 12 === 0;
        const y = yOf(m);
        ctx.strokeStyle = isC ? COLORS.gridC : COLORS.grid;
        ctx.lineWidth = isC ? 1 : 0.5;
        ctx.beginPath();
        ctx.moveTo(PAD_L, y);
        ctx.lineTo(cssW - PAD_R, y);
        ctx.stroke();
        if (isC) {
          ctx.fillStyle = COLORS.text;
          ctx.textAlign = 'right';
          ctx.fillText(noteName(m), PAD_L - 6, y);
        }
      }

      // ---- 目标音参考线 ----
      if (target !== null) {
        const y = yOf(target);
        ctx.strokeStyle = COLORS.target;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(PAD_L, y);
        ctx.lineTo(cssW - PAD_R, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = COLORS.target;
        ctx.textAlign = 'left';
        ctx.fillText(`目标 ${noteName(target)}`, PAD_L + 6, y - 8);
      }

      // ---- 音高曲线 ----
      const points = trace.snapshot();
      const now = (performance.now() - trace.startTimeMs) / 1000;
      const t0 = now - WINDOW_SEC;
      const xOf = (t: number) => PAD_L + ((t - t0) / WINDOW_SEC) * plotW;

      ctx.lineWidth = 2;
      let pen: { x: number; y: number; color: string } | null = null;

      for (const p of points) {
        if (p.t < t0 || !p.voiced || p.midi < yLow || p.midi > yHigh) {
          pen = null;
          continue;
        }
        const cents = target !== null ? (p.midi - target) * 100 : 0;
        const color = target !== null ? deltaColor(cents) : COLORS.free;
        const x = xOf(p.t);
        const y = yOf(p.midi);

        if (pen) {
          ctx.strokeStyle = pen.color === color ? color : pen.color;
          ctx.beginPath();
          ctx.moveTo(pen.x, pen.y);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        pen = { x, y, color };
      }

      // voiced 点小圆（取窗口内最后 ~60 个，避免过密）
      const visible = points.filter((p) => p.t >= t0 && p.voiced && p.midi >= yLow && p.midi <= yHigh);
      for (const p of visible.slice(-60)) {
        const cents = target !== null ? (p.midi - target) * 100 : 0;
        ctx.fillStyle = target !== null ? deltaColor(cents) : COLORS.free;
        ctx.beginPath();
        ctx.arc(xOf(p.t), yOf(p.midi), target !== null ? 2.5 : 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // ---- 时间轴 ----
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'left';
      ctx.fillText('-5s', PAD_L, cssH - 8);
      ctx.textAlign = 'right';
      ctx.fillText('现在', cssW - PAD_R, cssH - 8);

      // ---- 空态 ----
      if (!liveRef.current || visible.length === 0) {
        ctx.fillStyle = COLORS.text;
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        const text = liveRef.current
          ? '正在聆听…（发声后这里会出现音高曲线）'
          : '点击「开始录音」后显示实时音高曲线';
        ctx.fillText(text, PAD_L + plotW / 2, PAD_T + plotH / 2);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [trace]);

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} className="pitch-canvas" />
      <div className="chart-legend">
        {targetMidi !== null ? (
          <>
            <span><i className="lg lg-good" />±25¢ 准</span>
            <span><i className="lg lg-warn" />±50¢ 偏</span>
            <span><i className="lg lg-bad" />&gt;50¢ 跑调</span>
          </>
        ) : (
          <span><i className="lg lg-free" />实际音高（自由模式）</span>
        )}
        <span className="legend-window">最近 {WINDOW_SEC} 秒</span>
      </div>
    </div>
  );
}
