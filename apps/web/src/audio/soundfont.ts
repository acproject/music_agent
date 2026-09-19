// SoundFont 采样音色库：soundfont-player + MusyngKite 音色（真实乐器录音采样）。
//
// - 音源来自 gleitz/midi-js-soundfonts 项目（MusyngKite，mp3 切片），
//   经 jsdelivr CDN 镜像拉取（国内可访问），首次按乐器加载（0.3~3MB），
//   用 Cache API 持久化，再次加载走本地缓存；
// - 为彻底绕开库内硬编码的 github.io 地址，先自行 fetch 文本，
//   包装成以 .js 结尾的 Blob URL 再交给 soundfont-player 解析；
// - 加载失败时由播放器回退到内置振荡器合成，功能不中断。

import Soundfont, { type Player, type InstrumentName } from 'soundfont-player';

export interface GmInstrument {
  /** General MIDI program number 0-127（与导出 MIDI 的 program change 一致） */
  program: number;
  /** midi-js-soundfonts 音色文件名 */
  file: InstrumentName;
  label: string;
}

// 精选常用乐器（覆盖旋律/贝斯/铺底三类用途）
export const INSTRUMENTS: GmInstrument[] = [
  { program: 0, file: 'acoustic_grand_piano', label: '原声大钢琴' },
  { program: 1, file: 'bright_acoustic_piano', label: '亮音钢琴' },
  { program: 4, file: 'electric_piano_1', label: '电钢琴' },
  { program: 6, file: 'harpsichord', label: '羽管键琴' },
  { program: 24, file: 'acoustic_guitar_nylon', label: '尼龙木吉他' },
  { program: 25, file: 'acoustic_guitar_steel', label: '钢弦木吉他' },
  { program: 26, file: 'electric_guitar_jazz', label: '爵士电吉他' },
  { program: 32, file: 'acoustic_bass', label: '原声贝斯' },
  { program: 33, file: 'electric_bass_finger', label: '指弹电贝斯' },
  { program: 40, file: 'violin', label: '小提琴' },
  { program: 42, file: 'cello', label: '大提琴' },
  { program: 48, file: 'string_ensemble_1', label: '弦乐合奏' },
  { program: 56, file: 'trumpet', label: '小号' },
  { program: 60, file: 'french_horn', label: '圆号' },
  { program: 65, file: 'alto_sax', label: '中音萨克斯' },
  { program: 73, file: 'flute', label: '长笛' },
  { program: 74, file: 'recorder', label: '竖笛' },
  { program: 89, file: 'pad_2_warm', label: '温暖音垫' },
];

export function instrumentLabel(program: number): string {
  return INSTRUMENTS.find((i) => i.program === program)?.label ?? `GM ${program}`;
}

function instrumentFile(program: number): InstrumentName {
  return INSTRUMENTS.find((i) => i.program === program)?.file ?? 'acoustic_grand_piano';
}

const SOUNDFONT_SET = 'MusyngKite';
const remoteUrl = (file: InstrumentName): string =>
  `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/${SOUNDFONT_SET}/${file}-mp3.js`;

const cachePromise: Promise<Cache | null> =
  typeof caches !== 'undefined'
    ? caches.open('music-agent-soundfonts-v1').catch(() => null)
    : Promise.resolve(null);

/** 取音色 JSONP 文本：Cache API 命中优先，否则拉远程并写缓存。 */
async function fetchSoundfontText(file: InstrumentName): Promise<string> {
  const url = remoteUrl(file);
  const cache = await cachePromise;
  const hit = await cache?.match(url);
  if (hit) {
    return hit.text();
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`音色下载失败：HTTP ${res.status}`);
  }
  await cache?.put(url, res.clone()).catch(() => undefined);
  return res.text();
}

// 同一乐器只加载一次（AudioBuffer 全部在 resolve 前解码完成）
const players = new Map<number, Promise<Player>>();

export function loadInstrument(ctx: AudioContext, program: number): Promise<Player> {
  const existing = players.get(program);
  if (existing) {
    return existing;
  }
  const task = (async (): Promise<Player> => {
    const file = instrumentFile(program);
    const text = await fetchSoundfontText(file);
    // Blob URL 必须以 .js 结尾才会被 soundfont-player 识别为 soundfont 数据
    const blob = new Blob([text], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob) + '#.js';
    try {
      return await Soundfont.instrument(ctx, blobUrl as unknown as InstrumentName, { gain: 1 });
    } finally {
      // resolve 时采样已全部解码，安全释放
      setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    }
  })();
  players.set(program, task);
  task.catch(() => players.delete(program));
  return task;
}
