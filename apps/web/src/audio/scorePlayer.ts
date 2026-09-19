// 量化谱面在线播放：Web Audio 合成（无需音频文件/后端），按 BPM 精确排程。
//
// 设计：
//  - 所有音符一次性排进 AudioContext 时钟（start/stop 用音频时间，无 JS 定时器抖动）；
//  - 每个音 = 三角波基频 + 一个八度正弦泛音，经 ADSR 包络，音色偏柔和电钢琴；
//  - 播放的是谱面标准音高（按 MIDI 十二平均律），不含检测到的 cents 偏差，
//    便于学习者对照"正确音高"；
//  - 高亮回调走 requestAnimationFrame 轮询音频时钟，休止时段不高亮。

import type { QuantizedScore } from '../domain/quantize';
import { UNITS_PER_BEAT } from '../domain/quantize';

interface FlatEvent {
  /** 全局条目序号（与 StaffScore/JianpuScore 中 measures→items 展开顺序一致） */
  globalIndex: number;
  startSec: number;
  durationSec: number;
  midi: number | null;
}

export interface ScorePlayerHandlers {
  /** 当前应高亮的全局条目；休止或间隙时传 null */
  onActive: (globalIndex: number | null) => void;
  onEnd: () => void;
}

function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export class ScorePlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bus: GainNode | null = null;
  private oscillators: OscillatorNode[] = [];
  private rafTickId = 0;
  private rafEndId = 0;
  private startAt = 0;
  private events: FlatEvent[] = [];
  private handlers: ScorePlayerHandlers | null = null;
  private playing = false;

  get isPlaying(): boolean {
    return this.playing;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor!();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private flatten(score: QuantizedScore): FlatEvent[] {
    const secPerUnit = 60 / score.bpm / UNITS_PER_BEAT;
    const out: FlatEvent[] = [];
    let globalIndex = 0;
    for (const measure of score.measures) {
      let localUnits = 0;
      for (const item of measure.items) {
        out.push({
          globalIndex,
          startSec: (measure.startUnit + localUnits) * secPerUnit,
          durationSec: item.units * secPerUnit,
          midi: item.kind === 'note' ? (item.midi ?? null) : null,
        });
        localUnits += item.units;
        globalIndex += 1;
      }
    }
    return out;
  }

  /** 排程一个音：基频三角波 + 八度泛音，ADSR 包络。 */
  private scheduleNote(ctx: AudioContext, freq: number, start: number, duration: number): void {
    const bus = this.bus!;
    const noteGain = ctx.createGain();
    const attack = 0.008;
    const release = Math.min(0.08, duration * 0.3);
    const peak = 0.5;
    const sustainLevel = 0.32;
    noteGain.gain.setValueAtTime(0.0001, start);
    noteGain.gain.exponentialRampToValueAtTime(peak, start + attack);
    noteGain.gain.exponentialRampToValueAtTime(
      Math.max(sustainLevel, 0.0002),
      start + Math.min(0.12, duration * 0.4),
    );
    noteGain.gain.setValueAtTime(Math.max(sustainLevel, 0.0002), start + duration - release);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    noteGain.connect(bus);

    const fundamental = ctx.createOscillator();
    fundamental.type = 'triangle';
    fundamental.frequency.value = freq;
    fundamental.connect(noteGain);

    const overtone = ctx.createOscillator();
    overtone.type = 'sine';
    overtone.frequency.value = freq * 2;
    const overtoneGain = ctx.createGain();
    overtoneGain.gain.value = 0.18;
    overtone.connect(overtoneGain);
    overtoneGain.connect(noteGain);

    fundamental.start(start);
    fundamental.stop(start + duration + 0.02);
    overtone.start(start);
    overtone.stop(start + duration + 0.02);
    this.oscillators.push(fundamental, overtone);
  }

  async play(score: QuantizedScore, handlers: ScorePlayerHandlers): Promise<void> {
    this.teardown(false);
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    this.handlers = handlers;
    this.events = this.flatten(score);
    this.oscillators = [];

    // 每次播放独立 bus：停止时断开 bus 即可静音所有已排程音符
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(this.master!);
    this.bus = bus;

    const lead = 0.06;
    this.startAt = ctx.currentTime + lead;
    for (const ev of this.events) {
      if (ev.midi !== null) {
        this.scheduleNote(ctx, midiToFreq(ev.midi), this.startAt + ev.startSec, ev.durationSec * 0.95);
      }
    }

    const totalSec =
      this.events.reduce((acc, ev) => Math.max(acc, ev.startSec + ev.durationSec), 0) + 0.1;
    this.playing = true;
    this.rafTickId = requestAnimationFrame(this.tick);

    const hardStopAt = this.startAt + totalSec + 0.3;
    const checkEnd = () => {
      if (!this.playing) {
        return;
      }
      if (ctx.currentTime >= hardStopAt) {
        this.teardown(true);
      } else {
        this.rafEndId = requestAnimationFrame(checkEnd);
      }
    };
    this.rafEndId = requestAnimationFrame(checkEnd);
  }

  /** rAF 轮询音频时钟，定位当前条目并回调高亮。 */
  private tick = (): void => {
    if (!this.playing || !this.ctx) {
      return;
    }
    const pos = this.ctx.currentTime - this.startAt;
    let active: number | null = null;
    for (const ev of this.events) {
      if (pos >= ev.startSec && pos < ev.startSec + ev.durationSec && ev.midi !== null) {
        active = ev.globalIndex;
        break;
      }
    }
    this.handlers?.onActive(active);
    this.rafTickId = requestAnimationFrame(this.tick);
  };

  private teardown(notifyEnd: boolean): void {
    this.playing = false;
    cancelAnimationFrame(this.rafTickId);
    cancelAnimationFrame(this.rafEndId);
    for (const osc of this.oscillators) {
      try {
        osc.stop();
      } catch {
        // 已结束的排程节点忽略
      }
    }
    this.oscillators = [];
    this.bus?.disconnect();
    this.bus = null;
    this.handlers?.onActive(null);
    if (notifyEnd) {
      const h = this.handlers;
      this.handlers = null;
      h?.onEnd();
    } else {
      this.handlers = null;
    }
  }

  stop(): void {
    if (!this.playing && !this.bus) {
      return;
    }
    this.teardown(true);
  }
}
