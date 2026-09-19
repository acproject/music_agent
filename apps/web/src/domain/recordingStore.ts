// 最近一次录音/转谱上下文的模块级共享 store。
//
// 转谱面板（TranscribePanel）在分析成功后写入；AI 老师面板（AgentChat）
// 在发起对话时读取，随 /api/agent/chat 带给后端工具。采用 useSyncExternalStore
// 外部 store 模式，避免在 App 层做 props 钻取；未来接入服务端会话后，
// 只需把此处替换成 recording_id 获取，调用点不变。

import { useSyncExternalStore } from 'react';

export interface RecordingSnapshot {
  pcm: Float32Array | null;
  sampleRate: number;
  label: string;
  durationSec: number;
  analyzedAt: number | null;
}

const EMPTY: RecordingSnapshot = {
  pcm: null,
  sampleRate: 16_000,
  label: '',
  durationSec: 0,
  analyzedAt: null,
};

let current: RecordingSnapshot = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

export const recordingStore = {
  getSnapshot: (): RecordingSnapshot => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set(next: Omit<RecordingSnapshot, 'durationSec'> & { durationSec?: number }): void {
    current = {
      pcm: next.pcm,
      sampleRate: next.sampleRate,
      label: next.label,
      durationSec: next.durationSec ?? (next.pcm ? next.pcm.length / next.sampleRate : 0),
      analyzedAt: next.analyzedAt,
    };
    emit();
  },
};

/** 最近一次录音上下文（无录音时 pcm=null）。 */
export function useRecording(): RecordingSnapshot {
  return useSyncExternalStore(recordingStore.subscribe, recordingStore.getSnapshot);
}
