# Agent 闭环打通（Phase 1 收尾）实现方案

## 一、仓库调研结论

### 已具备（可直接复用，不重写）

- [react.rs](file:///d:/workspace/rust_projects/music_agent/crates/agent/src/react.rs)：ReAct 循环已完整（system 护栏 prompt 禁止伪造分析结果、tool_calls 回灌、`TOOL_ERROR` 回灌、max_iterations），**只缺被路由调用**。
- [openai.rs](file:///d:/workspace/rust_projects/music_agent/crates/agent/src/openai.rs)：OpenAI 兼容 provider（OpenAI/Qwen/DeepSeek/Ollama/vLLM），含重试/代理；[config](file:///d:/workspace/rust_projects/music_agent/crates/config/src/lib.rs#L67-L74) 已有 `LLM_*` 全套环境变量。
- [tool.rs](file:///d:/workspace/rust_projects/music_agent/crates/agent/src/tool.rs)：`AgentTool` trait；[registry.rs](file:///d:/workspace/rust_projects/music_agent/crates/tools/src/registry.rs) 注册表；唯一现成工具 [PingEngineTool](file:///d:/workspace/rust_projects/music_agent/crates/tools/src/health.rs)。
- 网关 [main.rs](file:///d:/workspace/rust_projects/music_agent/crates/api/src/main.rs#L47-L58) 只挂 3 条路由，`AppState` 无 LLM 字段；`music-api` 的 Cargo.toml **已依赖** music-agent / music-tools，接线零新依赖。
- [AnalysisEngine::analyze_audio](file:///d:/workspace/rust_projects/music_agent/crates/analysis-client/src/lib.rs#L98-L107) 可直接一元调用（deadline 60s），入参 `AnalyzeAudioRequest{recording_id,pcm,sample_rate,channels,pipeline}`。
- 前端 [TranscribePanel.tsx](file:///d:/workspace/rust_projects/music_agent/apps/web/src/components/TranscribePanel.tsx) 持有最近一次 PCM（`pcmRef`）与 `AnalyzeResponse`；网关 body 上限 64MB（[analyze.rs:32](file:///d:/workspace/rust_projects/music_agent/crates/api/src/routes/analyze.rs#L32)）。

### 关键约束与取舍

1. **无会话持久化**：录音/分析结果当前不入库（analysis_results 表有但不写）。本期**不引入服务端 session 存储**，采用**请求级上下文**：前端每次对话把最近一次录音 PCM（base64）随 JSON 带上，工具按需真实调 gRPC。符合"Agent → Tool → 结构化证据"硬约束，且为未来 session 化预留替换点。
2. **工具在一次 Agent 运行内共享一次引擎调用**：`analyze_pitch/detect_notes/analyze_rhythm/transcribe_music` 底层是同一次 `pipeline=["notes","midi","rhythm"]` 分析，经请求级 `RecordingContext` 缓存，模型连调多个工具不会重复跑引擎。
3. **无录音时工具不报错文本、返回结构化 `status:"no_recording"` 证据**，Agent 据此引导用户先录音，而不是编造。
4. **LLM 未配置时路由返回 503 + 中文配置指引**（沿用 CREPE 的降级模式），前端明确展示。
5. 本期范围只做 prompt §16 工具清单中与 Phase 1/2 分析相关的子集；`detect_chords / generate_exercise / get_student_profile / analyze_vocal / compare_performance` 等属于后续阶段，不做。
6. 对话接口本期为**一元 JSON**（非 SSE）：ReActAgent 本身只返回最终消息。工具调用过程已通过 `tracing::info!("agent tool call")` 落网关日志，可作为"未伪造"的审计证据；流式输出留待后续。

## 二、接口设计

### `POST /api/agent/chat`

请求：

```json
{
  "messages": [
    { "role": "user", "content": "帮我看看这段录音的节奏和音准" }
  ],
  "recording": {
    "pcm_base64": "AAAA...（Float32LE 的 base64，可空）",
    "sample_rate": 16000,
    "channels": 1,
    "label": "合成变速测试音（120→90）"
  }
}
```

- `messages` 为不含 system 的完整会话历史（多轮由前端携带）；只接受 role=user/assistant。
- `recording` 可空（纯乐理提问场景）；PCM 为空字符串视为无录音。

响应：

```json
{ "reply": "……", "model": "gpt-4o-mini" }
```

错误：
- `503 {"error":"llm_disabled","message":"未配置 LLM_API_KEY……（含 .env 指引）"}`
- `502 llm_status_error`（上游 4xx/5xx，截断 body）、`504 agent_max_iterations`、`400 bad_request`（消息为空/JSON 非法）。

## 三、文件与模块改动

### 后端（Rust）

- `crates/config/src/lib.rs`（编辑）
  - 新增 `AgentConfig { max_iterations: u32 }`，环境变量 `AGENT_MAX_ITERATIONS`（默认 6）；挂到 `AppConfig.agent`。
  - 新增判定 fn：LLM 启用条件 = `LLM_API_KEY` 非空 **或** `LLM_BASE_URL` host 为 localhost/127.0.0.1（本地 Ollama 无需 key）。
- `crates/api/src/state.rs`（编辑）：`AppState` 增加 `llm: Option<Arc<dyn LlmProvider>>`。
- `crates/api/src/main.rs`（编辑）：按配置构造 `OpenAiCompatibleProvider`（构造失败仅 warn 不退出进程 → llm=None）；挂载 `/api/agent/chat`。
- `crates/api/src/routes/mod.rs`（编辑）：注册 `agent` 模块。
- `crates/api/src/routes/analyze.rs`（小改）：把 base64 编码器拆出并新增 `base64_decode()`，`pub(crate)` 供 agent 路由复用（不引新依赖）。
- `crates/api/src/routes/agent.rs`（**新增**）：DTO 反序列化、base64 解码、构造请求级 `RecordingContext` → 注册 5 个音乐工具 + PingEngineTool → `ReActAgent::run` → 错误码映射。
- `crates/tools/src/recording.rs`（**新增**）：
  - `RecordingContext { engine: Arc<AnalysisEngine>, pcm: Option<Vec<u8>>, sample_rate, channels, label, cache: Mutex<Option<AnalyzeAudioResponse>> }`
  - `async fn ensure_analysis(&self) -> Result<Arc<AnalyzeAudioResponse>, ToolStatus>`：双检锁缓存；无 PCM 返回 `NoRecording`。
  - 纯函数投影（无引擎、可单测）：`project_pitch / project_notes / project_rhythm / project_transcription`，输入 `&AnalyzeAudioResponse`，输出 `serde_json::Value`。
  - 5 个工具结构体（均持有 `Arc<RecordingContext>`）：
    | 工具名 | 入参 | 返回证据 |
    |---|---|---|
    | `get_current_recording` | 无 | label、时长、采样率、是否可分析 |
    | `analyze_pitch` | 无 | 每个音 midi/音名由前端换算? 否——返回 midi+cents+onset+duration+confidence 列表 |
    | `detect_notes` | 无 | 音符数量、总时长、逐音 onset/duration/velocity |
    | `analyze_rhythm` | 无 | bpm、tempo 锚点、拍号、key、beat 列表（onset/beat/bar） |
    | `transcribe_music` | 无 | 完整摘要：notes+rhythm 关键字段 + MIDI 字节数（不回传 base64 给模型） |
- `crates/tools/src/lib.rs`（编辑）：导出上述类型。
- `crates/tools/Cargo.toml`（编辑）：新增 `music-domain`（workspace 依赖，proto 类型投影用）。
- `.env.example`（编辑）：补 `AGENT_MAX_ITERATIONS=6` 与启用说明注释。

### 前端（apps/web）

- `src/domain/recordingStore.ts`（**新增**，~40 行）：`useSyncExternalStore` 极简外部 store
  - 状态 `{ pcm: Float32Array | null; sampleRate; label; analyzedAt: number | null }`；模块级单例。
- `src/components/TranscribePanel.tsx`（小改）：`runAnalysis` 成功后写入 store（PCM + 文案 label：麦克风录音 / C-E-G-C / 120→90）；不动既有逻辑。
- `src/api/agent.ts`（**新增**）：`ChatMessage` 类型、`postChat(messages, recording)`；PCM→base64 用**分块 `btoa`**（避免 String.fromCharCode 爆栈）；PCM 原始字节上限 18MB（base64 后约 24MB，远小于 64MB 网关限制），超限不带 PCM 并在 UI 提示。
- `src/components/AgentChat.tsx`（**新增**）：
  - "AI 音乐老师"卡片：消息列表（user/teacher 气泡）、输入框、发送/等待中、错误展示（503 时显示配置指引、no recording 时提示先录音）；
  - 顶部显示当前携带的录音 label + 时长（读 recordingStore），无录音时仍可纯文字提问；
  - 快捷提问 chips：「分析这段录音的音准」「分析节奏与速度」「给出练习建议」；
  - 多轮历史保存在组件 state。
- `src/App.tsx`（小改）：挂载 `<AgentChat />`（置于转谱面板下方）；副标题更新为反映 M4 + Agent。
- `src/styles.css`（小改）：复用现有 card/button 风格加 chat 气泡/输入行样式（~60 行）。

### 文档

- `README.md`（小改）：HTTP 接口表补 `/api/agent/chat`；新增"AI 老师 Agent"小节（启用方式 LLM_API_KEY / Ollama、工具清单、证据约束说明）。

## 四、实施步骤（依赖顺序）

1. config：`AgentConfig` + 启用判定；`.env.example`。
2. tools/recording.rs：`RecordingContext` + 4 个投影纯函数 + 5 个工具；lib.rs/Cargo.toml 导出；**先写单测再挂路由**。
3. analyze.rs 抽 `pub(crate) base64_decode`。
4. state.rs + main.rs：构造 `llm: Option<...>`、挂路由。
5. routes/agent.rs：DTO、上下文装配、错误映射。
6. `cargo test`（workspace）+ `cargo build` 验证后端。
7. 前端 recordingStore → TranscribePanel 写入 → api/agent.ts → AgentChat.tsx → App 挂载 → 样式。
8. `pnpm exec tsc --noEmit` + `pnpm build`。
9. 端到端验证（见下）；README 更新。

## 五、依赖与注意事项

- 无新增第三方 crate（reqwest/async-trait/serde_json/tokio 均已在 workspace）。
- AgentTool trait **不改签名**：请求级数据通过"每次请求新建工具实例 + `Arc<RecordingContext>`"注入，避免侵入 agent 核心。
- 投影中音名不放在后端（保持引擎只给 MIDI 号）；模型可自行换算，前端展示层已有 noteName。
- `ChatMessage` 没有 assistant 构造器（react.rs 直接构造结构体），与本期无关，不动。
- 安全：recording JSON 不走 `Json<Value>` 透传，明确 DTO；消息条数前端限制最近 20 条，避免超长历史。
- 中文注释/UI 约定保持；不做 git commit；ps1/文档编码保持。

## 六、验证

- **Rust 单测**（`cargo test -p music-tools`）：
  - 手工构造 `AnalyzeAudioResponse`（2 个 NoteEvent + 2 个 tempo + beat/key 事件）断言四个投影 JSON 字段；
  - 无 PCM 时 `ensure_analysis` → NoRecording；
  - 工具 `parameters_schema()` 为合法 object schema；name/description 非空。
  - 全 workspace `cargo test` 保持绿。
- **前端**：tsc 零错误、`pnpm build` 通过。
- **浏览器**：
  1. 未配 LLM key：发消息得到 503 配置指引卡片（不崩、可重试）。
  2. 配置 key 后（用户提供 .env）重启网关：点「合成变速测试音」→ 问"分析节奏速度"，网关日志应出现 `agent tool call tool=analyze_rhythm`（以及 transcribe/pitch 之一），回复中引用 120→91 等**工具证据数值**；问与录音无关的乐理问题不应触发分析工具。
  3. 清空场景（刷新后未录音直接提问"分析我的录音"）→ Agent 引导先录音，不编造数值。
  4. console 无 error。
- **审计**：多轮对话里每轮工具调用在 RUST_LOG 日志可见，形成"模型只能引用工具结果"的证据链。

## 七、风险与处理

- **LLM 网络/Key（国内环境）**：provider 已支持 `LLM_BASE_URL` + `LLM_PROXY_URL`（Qwen/DeepSeek/镜像/Ollama）；未配置时 503 降级，不阻塞其他功能。真实 LLM 端到端需用户提供可用 key，自动化只能验证到 503 路径，已在步骤中说明。
- **PCM 体积**：18MB 原始字节上限（16kHz 单声道约 4.7 分钟），超出不带 PCM 并提示分段录音；未来 session 持久化后改传 recording_id。
- **多轮重复分析成本**：缓存仅请求级；同一轮内多工具只跑一次引擎，跨轮可能重跑。本期接受（未来由服务端会话缓存解决）。
- **模型不调工具空谈**：已有 system prompt 护栏 + 无证据时工具返回 no_recording；验证步骤专门覆盖此路径。
- **引擎不可用**：工具把引擎错误包成 `{status:"engine_down",error}` 证据返回（沿用 PingEngineTool 模式），Agent 须如实告知。
