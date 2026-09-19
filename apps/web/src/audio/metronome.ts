// 预备拍节拍器：训练录音前播放若干拍方波咔哒声，最后一拍高音提示进入。
// 从 SightSingingPanel 的内联实现抽出，视唱 / 节奏两个训练面板共用。

/** 从调用时刻到正式进入小节（应开始采集）的延迟（秒）。 */
export function countInEntryDelaySec(bpm: number, beats = 2): number {
  return 0.08 + (beats * 60) / bpm;
}

/**
 * 播放预备拍咔哒声（不阻塞）。返回正式进入的延迟秒数，调用方据此延迟开录。
 */
export function playCountIn(ctx: BaseAudioContext, bpm: number, beats = 2): number {
  const beatSec = 60 / bpm;
  const t0 = ctx.currentTime + 0.08;
  for (let i = 0; i < beats; i += 1) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = i === beats - 1 ? 1320 : 880;
    const t = t0 + i * beatSec;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  }
  return countInEntryDelaySec(bpm, beats);
}
