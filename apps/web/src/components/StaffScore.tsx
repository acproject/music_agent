import { useEffect, useRef } from 'react';
import { Dot, Formatter, Renderer, Stave, StaveNote, Voice } from 'vexflow';
import {
  type QuantizedScore,
  type ScoreItem,
  vexKey,
} from '../domain/quantize';

// 五线谱渲染：每个小节一个 Stave + 一个独立 Voice（时值由 quantize 保证填满整小节）。
// 不做跨行折行（M3）：外层容器横向滚动；M4+ 再做系统折行。

const STAVE_W = 240;
const STAVE_H = 150;
const FIRST_STAVE_X = 10;
const FIRST_STAVE_USABLE = STAVE_W - 100; // 谱号 + 拍号占位
const OTHER_USABLE = STAVE_W - 44;

function toTickable(item: ScoreItem, active: boolean, color: string | null): StaveNote {
  const duration = `${item.base}${item.kind === 'rest' ? 'r' : ''}`;
  // VexFlow 5：附点必须同时声明 dots（计入时值 tick）与 Dot 修饰符（渲染圆点），
  // 仅 addModifier(new Dot()) 是视觉附点，不会改变 tick，Voice 会报 IncompleteVoice。
  const note = item.kind === 'rest'
    ? new StaveNote({ keys: ['b/4'], duration, dots: item.dotted ? 1 : 0, autoStem: true })
    : new StaveNote({
        keys: [vexKey(item.midi ?? 60)],
        duration,
        dots: item.dotted ? 1 : 0,
        autoStem: true,
      });
  if (item.dotted) {
    note.addModifier(new Dot());
  }
  if (item.kind === 'note' && color) {
    note.setStyle({ fillStyle: color, strokeStyle: color });
  } else if (active && item.kind === 'note') {
    note.setStyle({ fillStyle: '#4f7cff', strokeStyle: '#4f7cff' });
  }
  return note;
}

export default function StaffScore({
  score,
  activeItem = null,
  noteColors = null,
}: {
  score: QuantizedScore | null;
  activeItem?: number | null;
  /**
   * 逐音着色，key 为 `小节:小节内音符序号`（均 1 基，休止不计数）。
   * 训练报告用它标 ok / 抢拖拍 / 错音。
   */
  noteColors?: Map<string, string> | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !score || score.measures.length === 0) {
      return;
    }

    host.innerHTML = '';
    const width = FIRST_STAVE_X * 2 + score.measures.length * STAVE_W;
    const renderer = new Renderer(host, Renderer.Backends.SVG);
    renderer.resize(width, STAVE_H);
    const context = renderer.getContext();

    // 每个小节首个 item 的全局序号（与 ScorePlayer.flatten 的展开顺序一致）
    let globalBase = 0;
    score.measures.forEach((measure, i) => {
      const x = FIRST_STAVE_X + i * STAVE_W;
      const stave = new Stave(x, 20, STAVE_W);
      if (i === 0) {
        stave.addClef('treble').addTimeSignature(score.timeSignature);
      }
      stave.setContext(context).draw();

      const voice = new Voice({
        numBeats: 4,
        beatValue: 4,
      });
      // 小节内已见音符数（休止不计数），用于查 noteColors
      let soundingInMeasure = 0;
      voice.addTickables(
        measure.items.map((item, ii) => {
          if (item.kind === 'note') {
            soundingInMeasure += 1;
          }
          const color = item.kind === 'note' && noteColors
            ? (noteColors.get(`${i + 1}:${soundingInMeasure}`) ?? null)
            : null;
          return toTickable(item, globalBase + ii === activeItem, color);
        }),
      );

      new Formatter()
        .joinVoices([voice])
        .format([voice], i === 0 ? FIRST_STAVE_USABLE : OTHER_USABLE);
      voice.draw(context, stave);

      globalBase += measure.items.length;
    });
  }, [score, activeItem, noteColors]);

  if (!score || score.measures.length === 0) {
    return null;
  }

  return (
    <div className="score-scroll">
      <div ref={hostRef} className="staff-host" />
    </div>
  );
}
