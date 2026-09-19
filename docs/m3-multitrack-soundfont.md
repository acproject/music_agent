# 多音轨 + SoundFont 音色库改造变更摘要

- **提交**：`93902d4`（2026-09-19）
- **规模**：11 个文件，+1051 / −135 行
- **范围**：M3 离线转谱链路（Python 分析服务 + Web 前端）

## 一、改造目标

原导出 MIDI 为单轨单声道、播放仅用振荡器合成。本次实现：

1. MIDI 多音轨（Standard MIDI File Format-1）；
2. 接入 SoundFont 真实乐器采样音色库，提升播放/还原真实度；
3. 自动生成低音与和弦垫伴奏轨；
4. 分轨混音 UI（选乐器 / 调音量 / 伴奏开关）与多轨 MIDI 导出。

## 二、变更清单

### 后端（Python 分析服务）

| 文件 | 变更 | 要点 |
|---|---|---|
| `services/analysis/app/midi.py` | 重写 | 纯标准库 Format-1 SMF 写入器 `write_smf_multitrack()`：TPQ=480、指挥轨（速度 FF51 + 拍号 FF58）、乐器轨（UTF-8 轨道名 FF03 + program change + note on/off）、通道自动去重并避开 9 号鼓通道；`write_smf()` 旧签名保留兼容 |
| `services/analysis/tests/test_midi.py` | 重写 | 解析器支持轨道名 / 拍号 / program / 通道；5 个用例覆盖多轨结构、tick 与力度、独立通道、鼓通道重映射、空音符 |

### 前端（apps/web）

| 文件 | 变更 | 要点 |
|---|---|---|
| `src/audio/soundfont.ts` | 新增（99 行） | SoundFont 加载器：18 种 GM 乐器、MusyngKite 采样走 jsdelivr CDN 镜像、Cache API 持久化缓存、Blob URL 注入（`.js` 后缀绕开库内硬编码地址）、按 program 去重的 Promise 缓存 |
| `src/domain/arrangement.ts` | 新增（181 行） | 自动编排：旋律音网格时长加权推断大调调性 → 每小节选与旋律音级重合度最高的顺阶三和弦（优先 I/IV/V/vi，末小节回 I 终止）→ 低音轨（C2 区根音长音）+ 和弦垫轨（C3 区根三五，低力度） |
| `src/domain/midiWriter.ts` | 新增（146 行） | TS 版多轨 SMF 写入器，逻辑与 Python 版对齐（TPQ=480、16 分网格 = 120 tick），供前端即时导出 |
| `src/audio/scorePlayer.ts` | 重写（217 行） | 多轨播放器：先并行加载全部音色再按 AudioContext 时钟统一排程（多轨严格对齐）；每轨独立 GainNode；采样失败自动回退 ADSR 振荡器合成；`onVoice` 回报每轨音色状态；rAF 轮询时钟仅高亮旋律音；停止即停全部声部并断开总线 |
| `src/components/TranscribePanel.tsx` | +145 行 | 混音器 UI：自动伴奏开关（显示推断调性）、每轨 GM 乐器下拉、音量滑块、音色徽章（加载中 / 采样音色 / 合成回退）；下载按钮改为按当前编排即时生成多轨 MIDI |
| `src/styles.css` | +86 行 | `.mixer` / `.mixer-row` / `.voice-badge` 等混音器样式 |
| `README.md` | M3 段落 | 补充多轨、SoundFont、自动伴奏与多轨导出说明 |
| `package.json` / `pnpm-lock.yaml` | 依赖 | 新增 `soundfont-player@0.12.0`（自带 TS 类型） |

## 三、关键设计决策

- **音源分发**：soundfont-player 默认音源在 gleitz.github.io（国内访问慢），改为 jsdelivr 镜像
  `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/MusyngKite/<name>-mp3.js`；
  自行 fetch 文本后包装为带 `.js` 后缀的 Blob URL 交给库解析（满足其 isSoundfontURL 正则），
  成功响应写入 Cache API（`music-agent-soundfonts-v1`），二次加载走本地缓存。
- **排程时序**：音色首次加载需数 MB 下载，因此先 `Promise.all` 并行加载全部乐器，
  全部就绪后再确定 `startAt` 一次性排程，避免下载耗时导致多轨错位。
- **优雅降级**：任一乐器加载失败时该轨回退到振荡器（三角波基音 + 正弦泛音 + ADSR 包络），
  播放功能不中断，UI 以红色"合成回退"徽章明示。
- **通道规划**：旋律轨通道 0，伴奏轨 1、2；写入器统一做通道去重并跳过 9 号鼓通道。
- **自动伴奏规则（M3 试做）**：固定 4/4；调性按音级网格时长加权取覆盖度最高的大调；
  每小节一个顺阶三和弦；空小节不生成伴奏；全部事件量化到 16 分网格，确定性、零延迟。

## 四、验证结果

- **Python 单测**：`python -m unittest discover -s tests` → 28 项全部通过
- **类型检查**：`pnpm exec tsc --noEmit` 零错误；IDE 诊断零问题
- **浏览器端到端**（合成 C-E-G-C 测试音）：
  - 三轨首次从 CDN 加载后均显示绿色"采样音色"，推断调性"C 大调"；
  - 播放时简谱依次高亮 1 → 3 → 5 → 高音 1，播放自然收尾、中途停止立即静音；
  - 关闭自动伴奏后仅余旋律轨，重放正常；控制台无 error / warning；
  - 前端导出 MIDI 字节校验：`MThd / format=1 / ntrk=3 / TPQ=480 / 3×MTrk` 正确。

## 五、已知约束与后续

- 自动伴奏为规则法（固定 4/4、大调推断、每小节一个和弦）；M4 自动节拍 / 调性检测落地后，
  可直接替换 `arrangement.ts` 的推断输入，接口无需改动。
- 采样播放仍按标准音高，不含 cents 偏差（沿用 M3 既有约定）。
- 鼓通道逻辑已在两端写入器预留，当前编排未使用。
- 后端返回的 `midi_base64`（单旋律轨）保留未删；前端下载已改用本地多轨生成。
- 浏览器自动化无法监听声音，发声链路按排程与状态验证，真实听感需本机试听。
