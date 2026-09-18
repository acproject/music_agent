import { Fragment } from 'react';
import type { QuantizedScore, ScoreItem } from '../domain/quantize';

// 简谱渲染：与五线谱共用 quantize() 的唯一输出（C 大调固定调唱名，M3 不做移调）。
// 时值约定：四分音符=数字；八分/十六分加一/二条减时线；
// 二分/全分在数字后补 1/3 条增时线；附点用「·」。高/低八度点位于数字上/下方。

const DEGREE_TEXT = ['1', '#1', '2', '#2', '3', '4', '#4', '5', '#5', '6', '#6', '7'];

function degreeParts(midi: number): { degree: string; accidental: string } {
  const pc = ((midi % 12) + 12) % 12;
  const text = DEGREE_TEXT[pc];
  return text.length === 1
    ? { degree: text, accidental: '' }
    : { degree: text[1], accidental: text[0] };
}

/** 相对中音区（C4=1 不带点）的八度点数：正=高音点，负=低音点。 */
function octaveDots(midi: number): number {
  return Math.floor((midi - 60) / 12);
}

function Glyph({ item }: { item: ScoreItem }) {
  const isRest = item.kind === 'rest';
  const degree = isRest ? '0' : degreeParts(item.midi ?? 60).degree;
  const accidental = isRest ? '' : degreeParts(item.midi ?? 60).accidental;
  const dots = isRest ? 0 : octaveDots(item.midi ?? 60);
  const beams = item.base === '8' ? 1 : item.base === '16' ? 2 : 0;
  const dotString = '·'.repeat(Math.abs(dots));

  return (
    <span className={`jp-glyph ${beams === 1 ? 'jp-beam1' : ''} ${beams === 2 ? 'jp-beam2' : ''}`}>
      <span className="jp-oct jp-above">{dots > 0 ? dotString : ''}</span>
      <span className="jp-num-row">
        {accidental && <span className="jp-accid">{accidental === '#' ? '♯' : '♭'}</span>}
        <span className="jp-num">{degree}</span>
      </span>
      <span className="jp-oct jp-below">{dots < 0 ? dotString : ''}</span>
    </span>
  );
}

/** 把一个量化条目渲染为 [数字/休止] + 增时线 + 附点序列。
 *  附点二分 = 数字 + 增时线 + 附点（1—·，共 3 拍）。 */
function ItemUnits({ item }: { item: ScoreItem }) {
  const dashes = item.base === 'w' ? 3 : item.base === 'h' ? 1 : 0;

  return (
    <Fragment>
      <Glyph item={item} />
      {Array.from({ length: dashes }, (_, i) => (
        <span className="jp-dash" key={`dash-${i}`}>—</span>
      ))}
      {item.dotted && <span className="jp-dot">·</span>}
    </Fragment>
  );
}

export default function JianpuScore({ score }: { score: QuantizedScore | null }) {
  if (!score || score.measures.length === 0) {
    return null;
  }

  return (
    <div className="jianpu">
      {score.measures.map((measure, mi) => (
        <div className="jp-measure" key={mi}>
          <span className="jp-bar-no">{mi + 1}</span>
          {measure.items.map((item, ii) => (
            <ItemUnits item={item} key={ii} />
          ))}
        </div>
      ))}
    </div>
  );
}
