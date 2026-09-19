// 多轨谱面播放器。
//
// - 每轨一个 GM 音色：优先用 SoundFont 真实采样（loadInstrument），
//   加载失败自动回退到振荡器合成（音色状态经 onVoice 回调上抛 UI）；
// - 采样/合成均按 AudioContext 时钟精确排程，无 JS 定时器抖动；
// - 每轨独立 GainNode 做音量混合；停止时断开总线并 stop 所有采样声部；
// - 高亮：仅旋律音带 globalIndex，rAF 轮询音频时钟定位当前条目。

import type { ArrangementNote } from '../domain/arrangement';
import { unitsToSec, type TempoAnchor } from '../domain/tempoMap';
import { loadInstrument } from './soundfont';
import type { Player } from 'soundfont-player';

export interface PlaybackTrack {
  id: string;
  program: number;
  gain: number;
  notes: ArrangementNote[];
}

export type VoiceKind = 'sampled' | 'synth';

export interface ScorePlayerHandlers {
  onActive: (globalIndex: number | null) => void;
  onEnd: () => void;
  /** 每轨最终发声方式（采样 / 合成回退） */
  onVoice?: (trackId: string, kind: VoiceKind) => void;
}

interface FlatEvent {
  globalIndex: number | null;
  startSec: number;
  endSec: number;
  midi: number;
  velocity: number;
}

function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function flatten(track: PlaybackTrack, tempoMap: TempoAnchor[]): FlatEvent[] {
  return track.notes.map((n) => ({
    globalIndex: n.globalIndex ?? null,
    startSec: unitsToSec(n.startUnit, tempoMap),
    endSec: unitsToSec(n.startUnit + n.durationUnits, tempoMap),
    midi: n.midi,
    velocity: n.velocity,
  }));
}

export class ScorePlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bus: GainNode | null = null;
  private fallbackOscillators: OscillatorNode[] = [];
  private samplePlayers: Player[] = [];
  private rafTickId = 0;
  private rafEndId = 0;
  private startAt = 0;
  private eventsByTrack: Array<{ trackId: string; events: FlatEvent[] }> = [];
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
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** 振荡器回退声部（SoundFont 不可用时保底发声）。 */
  private scheduleSynthNote(
    ctx: AudioContext,
    dest: AudioNode,
    freq: number,
    start: number,
    duration: number,
    velocity: number,
  ): void {
    const noteGain = ctx.createGain();
    const peak = 0.5 * velocity;
    const attack = 0.008;
    const release = Math.min(0.08, duration * 0.3);
    noteGain.gain.setValueAtTime(0.0001, start);
    noteGain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + attack);
    noteGain.gain.exponentialRampToValueAtTime(
      Math.max(peak * 0.64, 0.0002),
      start + Math.min(0.12, duration * 0.4),
    );
    noteGain.gain.setValueAtTime(Math.max(peak * 0.64, 0.0002), start + duration - release);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    noteGain.connect(dest);

    const fundamental = ctx.createOscillator();
    fundamental.type = 'triangle';
    fundamental.frequency.value = freq;
    fundamental.connect(noteGain);
    const overtone = ctx.createOscillator();
    overtone.type = 'sine';
    overtone.frequency.value = freq * 2;
    const ovGain = ctx.createGain();
    ovGain.gain.value = 0.18;
    overtone.connect(ovGain);
    ovGain.connect(noteGain);

    fundamental.start(start);
    fundamental.stop(start + duration + 0.02);
    overtone.start(start);
    overtone.stop(start + duration + 0.02);
    this.fallbackOscillators.push(fundamental, overtone);
  }

  async play(
    tracks: PlaybackTrack[],
    tempoMap: TempoAnchor[],
    handlers: ScorePlayerHandlers,
  ): Promise<void> {
    this.teardown(false);
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    this.handlers = handlers;
    this.fallbackOscillators = [];
    this.samplePlayers = [];

    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(this.master!);
    this.bus = bus;

    // 每轨：展开事件（多段变速按 tempoMap 换算时间）+ 增益节点 + 并行加载音色
    const prepared = tracks.map((track) => {
      const events = flatten(track, tempoMap);
      this.eventsByTrack.push({ trackId: track.id, events });
      const trackGain = ctx.createGain();
      trackGain.gain.value = track.gain;
      trackGain.connect(bus);
      return { track, events, trackGain };
    });

    const voices = await Promise.all(
      prepared.map(async ({ track }) => {
        try {
          const player = await loadInstrument(ctx, track.program);
          handlers.onVoice?.(track.id, 'sampled');
          return { trackId: track.id, player };
        } catch {
          handlers.onVoice?.(track.id, 'synth');
          return { trackId: track.id, player: null };
        }
      }),
    );
    const voiceMap = new Map(voices.map((v) => [v.trackId, v.player]));

    // 所有音色就绪后再确定起始时刻并一次性排程，保证多轨严格对齐
    const lead = 0.08;
    this.startAt = ctx.currentTime + lead;

    for (const { track, events, trackGain } of prepared) {
      const player = voiceMap.get(track.id) ?? null;
      if (player) {
        // 采样器输出路由到本轨增益节点
        player.connect(trackGain);
        this.samplePlayers.push(player);
      }
      for (const ev of events) {
        const duration = (ev.endSec - ev.startSec) * 0.95;
        const when = this.startAt + ev.startSec;
        if (player) {
          // 运行时支持 MIDI 数字（sample-player isMidi），类型声明只收音名故此处转换
          player.play(ev.midi as unknown as string, when, { duration, gain: ev.velocity });
        } else {
          this.scheduleSynthNote(
            ctx,
            trackGain,
            midiToFreq(ev.midi),
            when,
            duration,
            ev.velocity,
          );
        }
      }
    }

    const totalSec =
      this.eventsByTrack.reduce(
        (acc, { events }) =>
          events.reduce((a, ev) => Math.max(a, ev.endSec), acc),
        0,
      ) + 0.1;

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

  private tick = (): void => {
    if (!this.playing || !this.ctx) {
      return;
    }
    const pos = this.ctx.currentTime - this.startAt;
    let active: number | null = null;
    for (const { events } of this.eventsByTrack) {
      for (const ev of events) {
        if (ev.globalIndex !== null && pos >= ev.startSec && pos < ev.endSec) {
          active = ev.globalIndex;
          break;
        }
      }
      if (active !== null) {
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
    // 采样声部：立刻停止所有乐器的排程音符（乐器实例保留在缓存中）
    for (const p of this.samplePlayers) {
      try {
        p.stop();
      } catch {
        // 忽略
      }
    }
    this.samplePlayers = [];
    for (const osc of this.fallbackOscillators) {
      try {
        osc.stop();
      } catch {
        // 已结束的节点忽略
      }
    }
    this.fallbackOscillators = [];
    this.bus?.disconnect();
    this.bus = null;
    this.eventsByTrack = [];
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
