// 直接引用由 proto 生成的跨端类型，证明 Web 端与 Rust/Python 共用同一契约。
import type { NoteEvent } from '../proto/music/v1/events.gen';

// 需求文档第 7 节示例：C4(midi=60)，1.25s 起，时长 0.48s
export const sampleNote: NoteEvent = {
  midi: 60,
  centsOffset: 0,
  onset: 1.25,
  duration: 0.48,
  velocity: 0.82,
  confidence: 0.97,
};
