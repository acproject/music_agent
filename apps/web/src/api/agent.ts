// AI 老师对话 REST 客户端：POST /api/agent/chat。
//
// 每次请求携带多轮历史与最近一次录音 PCM（base64），后端 Agent 仅通过
// 工具调用取得分析证据（详见 crates/tools/src/recording.rs）。

import type { RecordingSnapshot } from '../domain/recordingStore';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessageDto {
  role: ChatRole;
  content: string;
}

export interface RecordingPayload {
  pcm_base64: string;
  sample_rate: number;
  channels: number;
  label: string;
}

export interface ChatResponse {
  reply: string;
  model: string;
}

/** 随对话携带的 PCM 原始字节上限（超出则不带录音，提示分段）。 */
export const MAX_PCM_BYTES = 18 * 1024 * 1024;

/**
 * 分块 base64 编码，避免 String.fromCharCode 大参数爆栈。
 * 每块 0x8000 字节与 MDN 推荐的 btoa 分片写法一致。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk) as number[]);
  }
  return btoa(binary);
}

export interface BuiltRecording {
  recording: RecordingPayload | null;
  /** true 表示录音过长已被省略（后端将收到无录音上下文） */
  truncated: boolean;
}

/** 从共享录音快照构造请求载荷；无 PCM 或超限时返回 null。 */
export function recordingFromSnapshot(snap: RecordingSnapshot): BuiltRecording {
  if (!snap.pcm || snap.pcm.byteLength === 0) {
    return { recording: null, truncated: false };
  }
  if (snap.pcm.byteLength > MAX_PCM_BYTES) {
    return { recording: null, truncated: true };
  }
  const bytes = new Uint8Array(
    snap.pcm.buffer,
    snap.pcm.byteOffset,
    snap.pcm.byteLength,
  );
  return {
    recording: {
      pcm_base64: bytesToBase64(bytes),
      sample_rate: snap.sampleRate,
      channels: 1,
      label: snap.label,
    },
    truncated: false,
  };
}

export async function postChat(
  messages: ChatMessageDto[],
  recording: RecordingPayload | null,
): Promise<ChatResponse> {
  const resp = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, recording }),
  });
  let data: { message?: string; error?: string; reply?: string; model?: string } = {};
  try {
    data = await resp.json();
  } catch {
    // 非 JSON 响应
  }
  if (!resp.ok) {
    throw new Error(data.message ?? data.error ?? `HTTP ${resp.status}`);
  }
  if (typeof data.reply !== 'string') {
    throw new Error('Agent 响应缺少 reply 字段');
  }
  return { reply: data.reply, model: data.model ?? '' };
}
