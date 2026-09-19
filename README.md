# AI 音乐教学系统（music_agent）

哼唱/单音乐器的实时音高检测 + 离线音频转谱（音符 / MIDI）全链路原型，
并为后续 AI 音乐老师 Agent 预留 tool calling 能力。所有音乐数据统一走
`proto/music/v1` 契约，实时链路与离线链路严格分离。

- **实时**：浏览器麦克风 → WebSocket 流式 PCM → 逐帧 YIN 音高曲线
- **离线**：整段录音上传 → 音符分割 → NoteSequence / Standard MIDI File
- **双音高后端**：`yin`（纯 numpy，零额外依赖，默认）/ `crepe`（本地 CREPE ONNX 深度模型，CPU 推理）

## 系统架构

```
浏览器 (React + Vite :5173)
  │  麦克风 AudioWorklet 采集 16kHz / Float32 / 单声道
  │  REST：POST /api/music/analyze（原始 Float32LE PCM）
  │  WS  ：/api/audio/stream（实时音频块 ↔ PitchFrame 事件）
  ▼
Rust HTTP/WS 网关 music-api（axum :8080）
  │  鉴权/聚合/存储（SQLite）、gRPC 客户端
  ▼ gRPC（tonic，music.v1.AnalysisService :50051）
Python 分析引擎 services/analysis
  ├─ StreamAudio ：实时 YIN（numpy，40ms/帧）
  └─ AnalyzeAudio：NoteTracker 分割 → 音符 / MIDI
                   f0 后端可切换：YIN（默认）或 CREPE ONNX（onnxruntime）
```

契约层 `proto/music/v1/`：

- `analysis.proto`：Ping / StreamAudio / AnalyzeAudio 服务定义
- `events.proto`：MusicEvent / PitchFrame / NoteEvent / NoteSequence

三端（Rust / Python / TypeScript）的桩代码均由 `scripts/gen_proto.mjs`
从同一份 proto 生成，生成物不入库。

## 目录结构

```
proto/music/v1/          # 唯一数据契约（.proto）
scripts/
  gen_proto.mjs          # 跨平台 proto 生成（TS / Python / Rust 构建期）
  gen_python_proto.py    # Python gRPC 桩生成
  download_model.py      # CREPE ONNX 权重下载（镜像可切换/断点续传）
crates/                  # Rust workspace
  api/                   #   axum HTTP/WS 网关（:8080）
  analysis-client/       #   gRPC 客户端
  domain/ audio/ config/ storage/ agent/ tools/
services/analysis/       # Python 分析引擎（:50051）
  app/
    main.py              #   gRPC 服务入口 + 后端工厂
    pitch.py             #   YIN 实时音高（纯 numpy）
    model_pitch.py       #   CREPE ONNX 离线后端（懒加载 onnxruntime）
    notes.py             #   离线 Note 分割（与 f0 来源解耦）
    midi.py              #   Standard MIDI File 写出
  tests/                 #   unittest（25 个，无模型时 CREPE 用例自动 skip）
apps/web/                # React 19 + Vite 6 + VexFlow 前端（:5173）
deploy/                  # Dockerfile + docker-compose（引擎 + 网关）
models/crepe/            # 本地模型权重（不入库，由下载脚本生成）
```

## 前置依赖

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| Rust | ≥ 1.85 | workspace 固定 edition 2021 |
| Node.js | ≥ 18 | proto 生成与前端；包管理器用 pnpm |
| Python | 3.12 | 分析引擎；依赖见 `services/analysis/requirements.txt` |
| protoc | 3.x | Rust（tonic-build）与 Web（ts-proto）代码生成需要 |

Windows PowerShell 下若 protoc 不在 PATH：

```powershell
$env:PROTOC="C:\Users\<you>\.local\bin\protoc\bin\protoc.exe"
```

## 快速开始

### 1. 生成 proto 桩代码

```bash
node scripts/gen_proto.mjs all      # web + python（Rust 在 cargo build 时自动生成）
```

### 2. 启动 Python 分析引擎（:50051）

```bash
cd services/analysis
python -m pip install -r requirements.txt
python -m app.main
```

### 3. 启动 Rust 网关（:8080）

```bash
cargo run -p music-api
```

### 4. 启动 Web 前端（:5173）

```bash
cd apps/web
pnpm install        # postinstall 会自动生成 web proto
pnpm dev
```

浏览器打开 http://localhost:5173 （Vite 已把 `/api`、`/health`
代理到 :8080，WebSocket 同样代理）。

配置可复制 `.env.example` 为 `.env` 调整（网关、LLM、存储、分析服务）。

### 一键启停脚本（可选）

`scripts/` 下提供跨平台脚本，自动做端口冲突检查、proto 产物/依赖预检、
启动后健康探测；日志落 `logs/`，PID 落 `.run/`（均已 gitignore）。

| 操作 | Windows（PowerShell） | Linux / macOS（bash） |
| --- | --- | --- |
| 启动全部 | `scripts\start-all.ps1` | `scripts/start-all.sh` |
| 停止全部 | `scripts\stop-all.ps1` | `scripts/stop-all.sh` |
| 查看状态 | `scripts\status.ps1` | `scripts/status.sh` |

```powershell
# Windows：默认执行策略可能拦截，用 -ExecutionPolicy Bypass 运行
powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
# 指定 CREPE 后端 / 跳过前端：
powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1 -PitchBackend crepe -NoWeb
powershell -ExecutionPolicy Bypass -File scripts\stop-all.ps1
```

```bash
# Linux / macOS（首次需可执行权限）
chmod +x scripts/*.sh
scripts/start-all.sh                  # 默认 PITCH_BACKEND=yin
scripts/start-all.sh --backend crepe  # 或 PITCH_BACKEND=crepe scripts/start-all.sh
scripts/status.sh
scripts/stop-all.sh
```

Windows 下每个服务会开一个独立 PowerShell 窗口（直接看实时日志，关窗即停该服务）；
Linux 下以 `setsid` 独立进程组后台运行。也支持 `--no-engine` / `--no-api` /
`--no-web` 单独跳过某服务。Python 解释器可用环境变量 `PYTHON` 覆盖。

### 平板 / 手机局域网访问（麦克风需要 HTTPS）

浏览器只在安全上下文开放麦克风（`getUserMedia`）：`localhost` 天然可用，
但通过 `http://<局域网IP>:5173` 访问时麦克风 API 会被整个禁用，设备列表显示
“未检测到设备”。需要局域网访问时，带 `DEV_HTTPS=1` 启动前端（自签证书在启动时
动态生成，SAN 自动覆盖本机所有局域网 IP）：

```powershell
# Windows PowerShell
$env:DEV_HTTPS = '1'
powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
```

```bash
# Linux / macOS
DEV_HTTPS=1 scripts/start-all.sh
```

然后在平板浏览器打开 **`https://<本机局域网IP>:5173`**（注意是 https），首次会有
证书警告，选择“高级 → 继续访问”，再在弹窗中允许麦克风即可。REST 与 WebSocket
均经 Vite 同源代理，网关系保持 HTTP 本机监听，无需改动。

其他注意：

- 平板与电脑需在同一 Wi-Fi；Windows 防火墙需放行入站 TCP 5173（专用网络）。
- 若 HTTPS 下设备列表仍为空，检查 Windows「设置 → 隐私和安全性 → 麦克风」
  是否允许桌面应用访问麦克风，以及声音面板中输入设备未被禁用。
- 本机开发直接用 http://localhost:5173 即可，无需 HTTPS。

### Docker 一键起后端

```bash
docker compose -f deploy/docker-compose.yml up --build
# analysis :50051，api :8080
```

## 高质量音高后端：CREPE（可选）

默认后端 `yin` 无需任何模型。需要更高基频精度时，可切换为本地
CREPE ONNX 模型（CPU 版 onnxruntime，**不需要 torch**）。

### 下载权重（默认国内镜像）

```bash
# 默认从 https://hf-mirror.com 下载 tiny 到 models/crepe/
python scripts/download_model.py

# 多规格 / 全部（tiny≈1.9MB，small≈6.2MB，…，full≈94MB）
python scripts/download_model.py --models tiny,small
python scripts/download_model.py --models all

# 切回 Hugging Face 官方源（或任何兼容镜像）
python scripts/download_model.py --endpoint https://huggingface.co
$env:HF_ENDPOINT="https://hf-mirror.com"   # 环境变量方式
```

下载器仅用标准库，支持**断点续传**与自动重试，完成后计算 sha256 写入
`models/crepe/manifest.json`，并在检测到 onnxruntime 时自动做一次加载校验。
权重目录已在 `.gitignore` 中忽略。

### 切换后端

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PITCH_BACKEND` | `yin` | 离线 AnalyzeAudio 后端：`yin` / `crepe` |
| `CREPE_MODEL` | `tiny` | `tiny` `small` `medium` `large` `full` |
| `CREPE_MODEL_DIR` | 仓库根 `models/crepe` | 权重目录 |
| `CREPE_MIN_CONFIDENCE` | `0.5` | voiced 置信度门限 |

```powershell
$env:PITCH_BACKEND="crepe"
$env:CREPE_MODEL="tiny"
python -m app.main
```

- 实时 WebSocket 链路**始终使用 YIN**，不受开关影响；
- 引擎启动时会预热 CREPE，缺权重或缺 onnxruntime 立即以中文指引报错退出；
- 请求到达时后端不可用，网关返回 `503` 并附带修复方法。

实测（合成琶音 C4-E4-G4-C5，2.16s 单声道 16kHz，经网关整链路）：
两后端均准确切出 MIDI 60/64/67/72 四个音；CREPE(tiny) 音分偏差 ±3 cents、
帧置信度 0.83–0.91。

## HTTP / WS 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 网关与引擎健康状态 |
| GET | `/api/audio/stream` | WebSocket：实时音频块 → PitchFrame 事件 |
| POST | `/api/music/analyze` | 离线分析；body 为原始 `Float32LE` PCM（`application/octet-stream`） |

Analyze 查询参数：`sample_rate`（默认 16000，8k–192k）、`channels`（默认 1，
多声道自动下混）、`pipeline`（默认 `notes,midi`，可选 `pitch,notes,midi`）。

```bash
curl -X POST "http://127.0.0.1:8080/api/music/analyze?sample_rate=16000&pipeline=notes,midi" \
     --data-binary @recording.f32 -H "Content-Type: application/octet-stream"
```

响应 JSON：`sequence.notes[]`（midi / cents_offset / onset / duration /
velocity / confidence）、`events[]`、`midi_base64`（Standard MIDI File）。

## 测试

```bash
# Python：services/analysis 目录下（无 CREPE 权重时相关用例自动 skip）
python -m unittest discover -s tests

# Rust
cargo test

# Web 类型检查 / 构建
cd apps/web && pnpm build
```

## 开发里程碑

- **M0** 工作区骨架：proto 契约、Python gRPC 引擎 Ping、Rust 网关、Docker
- **M2** 实时链路：YIN 音高检测、WebSocket 透传、前端麦克风采集与音高曲线
- **M3** 离线转谱：整段 f0 轨迹 + 频谱通量起音 → Note 分割 → NoteSequence / MIDI，
  五线谱/简谱渲染（支持浏览器内按 BPM 合成播放并同步高亮当前音符）；
  新增可切换 CREPE ONNX 高质量后端与镜像下载工具；
  MIDI 升级为 Format-1 多音轨（指挥轨 + 旋律轨），前端接入 SoundFont（MusyngKite）
  真实采样音色库（jsdelivr CDN + Cache API 本地缓存，加载失败自动回退振荡器合成），
  并按推断调性自动生成低音 / 和弦垫伴奏轨，支持分轨选择 GM 乐器、调音量，
  可导出含完整编排的多轨 MIDI
- **M4（计划）** 节拍/速度自动检测，替换当前固定 BPM=100 的量化假设

完整产品设计见 [prompt.md](prompt.md)。
