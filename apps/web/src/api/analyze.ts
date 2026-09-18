// 离线分析 REST 客户端：整段 Float32 PCM 上传到 Rust 网关，
// 由 Python 引擎 AnalyzeAudio 返回 NoteSequence + MIDI。
//
// 与实时 WebSocket 链路完全分开（见 prompt.md 原则：实时/高质量不混用）。

export interface NoteDto {
  midi: number;
  cents_offset: number;
  onset: number;
  duration: number;
  velocity: number;
  confidence: number;
}

export interface NoteSequenceDto {
  notes: NoteDto[];
  total_duration: number;
  bpm: number;
  key: string;
  time_signature: string;
}

export interface FlatEvent {
  type: string;
  [key: string]: unknown;
}

export interface AnalyzeResponse {
  recording_id: string;
  sequence: NoteSequenceDto;
  events: FlatEvent[];
  midi_base64?: string;
}

export type PipelineStep = 'pitch' | 'notes' | 'midi';

export interface AnalyzeOptions {
  sampleRate?: number;
  channels?: number;
  pipeline?: PipelineStep[];
}

export async function analyzeAudio(
  pcm: Float32Array,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResponse> {
  const params = new URLSearchParams({
    sample_rate: String(opts.sampleRate ?? 16_000),
    channels: String(opts.channels ?? 1),
    pipeline: (opts.pipeline ?? ['notes', 'midi']).join(','),
  });

  const resp = await fetch(`/api/music/analyze?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pcm.buffer,
  });

  if (!resp.ok) {
    let message = `HTTP ${resp.status}`;
    try {
      const data = (await resp.json()) as { message?: string; error?: string };
      message = data.message ?? data.error ?? message;
    } catch {
      // 非 JSON 错误体时保留状态码
    }
    throw new Error(message);
  }
  return (await resp.json()) as AnalyzeResponse;
}

/** 把网关返回的 base64 MIDI 触发为浏览器下载（.mid）。 */
export function downloadMidi(base64: string, filename = 'transcription.mid'): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
