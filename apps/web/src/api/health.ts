// Rust 网关 GET /health 的响应类型
export interface EngineStatus {
  connected: boolean;
  engine?: string;
  version?: string;
  error?: string;
}

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  analysis_engine: EngineStatus;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const resp = await fetch('/health');
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}
