# 多段变速 Tempo Map 实现方案

## 一、仓库调研结论

当前（M4 基线）全链路只有**单一速度**：

- 协议层已具备条件：`events.proto` 的 `TempoEvent { time, bpm }` 是可重复事件，
  `MusicEvent.oneof` 已含 `tempo=14`；网关 [out_events.rs](file:///d:/workspace/rust_projects/music_agent/crates/api/src/routes/out_events.rs)
  已把 tempo 扁平化为 `{type:'tempo', time, bpm}`——**proto 与 Rust 网关零改动**。
- 后端 [rhythm.py](file:///d:/workspace/rust_projects/music_agent/services/analysis/app/rhythm.py)
  只产出一个全局自相关 BPM，节拍点用固定 lag 等距铺设；[main.py](file:///d:/workspace/rust_projects/music_agent/services/analysis/app/main.py)
  只发 1 条 `TempoEvent(time=0)`，`NoteSequence.bpm` 为单值。
- 后端 [midi.py](file:///d:/workspace/rust_projects/music_agent/services/analysis/app/midi.py)
  指挥轨只写 1 个 FF51；乐器轨用常数 `sec_per_tick = 60/(bpm*480)` 把秒映射到 tick。
- 前端 [quantize.ts](file:///d:/workspace/rust_projects/music_agent/apps/web/src/domain/quantize.ts)
  用常数 `secPerUnit` 做秒→16 分网格；[midiWriter.ts](file:///d:/workspace/rust_projects/music_agent/apps/web/src/domain/midiWriter.ts)
  指挥轨单 FF51（但音符已是 tick 域，变速不影响音轨）；[scorePlayer.ts](file:///d:/workspace/rust_projects/music_agent/apps/web/src/audio/scorePlayer.ts)
  用常数 `secPerUnit` 排程与高亮；[arrangement.ts](file:///d:/workspace/rust_projects/music_agent/apps/web/src/domain/arrangement.ts)
  完全在网格（units）域工作，**变速天然不受影响**；VexFlow/简谱只依赖网格，**同样不受影响**。

核心结论：变速只需要解决一个问题——**秒 ↔ 音乐时间（tick/units）的分段线性映射**，
把该映射从"一个常数"升级为"按 TempoEvent 锚点分段积分"，并在生成端（rhythm）产出多个锚点。

## 二、数据模型（双端对齐）

Tempo Map 规范（Python/TS 同构）：

- 锚点升序数组 `[{timeSec, bpm}]`，首锚点 `timeSec=0`；
- 锚点 i 表示"从 timeSec(i) 起速度为 bpm(i)，直到下一锚点"；
- tick 域锚点由秒域锚点递推生成：
  `tick(i+1) = tick(i) + (timeSec(i+1)-timeSec(i)) * TPQ * bpm(i) / 60`；
- 映射函数（分段线性，TPQ=480，1 unit=120 tick）：
  - `secToTick(sec)` / `tickToSec(tick)`：顺序遍历分段做线性插值，末段按末速度外推；
  - `secToUnits(sec) = secToTick(sec)/120`（量化时取整规则与现状一致：四舍五入）。
- `NoteSequence.bpm`（int32）保留，填**占主导/中位 BPM**，仅为向后兼容与快速展示。

## 三、变更文件与模块

### 后端

1. `services/analysis/app/rhythm.py`
   - `RhythmResult` 新增 `tempo_map: list[tuple[float, int]]`（秒, bpm），`bpm` 改取主导速度；
   - 分段测速：在频谱通量包络上做滑窗（窗 4s / hop 1s）局部自相关 → 局部 BPM，
     经全局 BPM 八度校正；用迟滞合并（变化 ≥8% 且持续 ≥2 窗才切段，短于 ~2s 的段并入邻段）；
   - 节拍点改按各段局部周期铺设，跨段沿用小节相位（bar/beat 连续编号，beat==1 不变）；
   - 证据不足时输出单段（等价 M4 现状）。
2. `services/analysis/app/midi.py`
   - 新增内部 `sec_to_tick(tempo_map)` / 指挥轨多 FF51：在每个变化锚点对应的 tick 写速度元事件；
   - `write_smf_multitrack(..., tempo_map=None)`：乐器轨秒→tick 改用分段映射；
     `bpm` 参数保留（包装为单锚点，旧调用与测试全部兼容）。
3. `services/analysis/app/main.py`
   - 遍历 `rhythm.tempo_map` 发多条 `TempoEvent`（首条 time=0）；
   - `seq.bpm = rhythm.bpm`（主导），调用 `write_smf(..., tempo_map=...)`。
4. 测试：
   - `tests/test_rhythm.py`：两段速合成信号（前半 120 后半 90 脉冲）断言 2 段、
     锚点秒与 bpm、单段回退；
   - `tests/test_midi.py`：解析器支持多 FF51，断言各速度事件 tick/bpm、音符 tick 随段变化。

### 前端

5. `apps/web/src/domain/tempoMap.ts`（**新增**）
   - 类型 `TempoAnchor`/`TempoMap`；`constantTempoMap(bpm)`；
   - `tempoMapFromEvents(events, fallbackBpm)`（从扁平 events 的 `type==='tempo'` 构建）；
   - `secToTick/tickToSec/secToUnits/unitsToSec`（纯函数，附简易自测点）。
6. `apps/web/src/domain/quantize.ts`
   - `quantize(notes, { tempoMap, beatsPerBar })`：内部把常数 secPerUnit 全部换成
     `secToUnits()`（放置/重叠/补休止逻辑不变，取整点不变）；
   - `QuantizedScore` 增加 `tempoMap`，`bpm` 保留为首段速度；调用点仅面板一处，同步改签名。
7. `apps/web/src/domain/midiWriter.ts`
   - `writeSmf(tracks, tempoMap, numerator?, denominator?)`：指挥轨按锚点 tick 写多个 FF51；
     音符已在 tick 域，无需改。
8. `apps/web/src/audio/scorePlayer.ts`
   - `play(tracks, tempoMap, handlers)`：排程与高亮的 startSec/endSec 用 `unitsToSec()` 映射，
     其余（采样加载、Gain 总线、rAF）不动。
9. `apps/web/src/components/TranscribePanel.tsx`
   - 从 result.events 构建 tempoMap；手动改 BPM 下拉 → 恒定 map 覆盖（保留"检测/手动"语义）；
   - 量化栏展示速度段摘要（如 `♩=111 → 96 @2.4s`）；下载多轨 MIDI 传 tempoMap。
10. `styles.css`：速度段 chip 样式（复用 .meta/.voice-badge 风格，量很小）。

## 四、实施步骤（依赖顺序）

1. 后端 midi.py：分段映射 + 多 FF51（先不接 rhythm，用构造的多段 map 写测试）；
2. 后端 rhythm.py：分段测速 + tempo_map；main.py 发多事件并传 map；补两组单测；
3. 全量 `python -m unittest discover -s tests`（现有 38 项必须保持绿）；
4. 前端 tempoMap.ts + quantize.ts 改造（领域层先行，不碰 UI）；
5. midiWriter.ts / scorePlayer.ts 改签名消费 map；
6. TranscribePanel.tsx 接线（events→map、手动覆盖、段摘要、下载传 map）；
7. `tsc --noEmit` + IDE 诊断；重启引擎，浏览器做两段速合成信号端到端验证。

## 五、依赖与注意事项

- **无新增依赖**：后端纯 numpy，前端纯 TS；proto / Rust 网关不改。
- 量化取整仍在 16 分网格上做；变速点附近音符归属由 `secToUnits` 四舍五入决定，
  与 M4 单速行为在单段 map 下**逐值等价**（回归安全）。
- 后端 `midi_base64`（秒→tick）与前端导出（先量化到网格再→tick）会有 ≤1 网格的舍入差异，
  这是既有现象；多轨编排导出以前端为规范。
- 拍号本期保持单曲恒定；tempo map 不处理调号/拍号变化（`MeasureEvent` 已按节拍相位生成）。
- 前端 SoundFont 排程是绝对时间，变速只改变 units→sec 的换算，采样加载逻辑零改动。

## 六、验证

- Python：新增分段测速 / 多 FF51 用例；全量单测通过；
- TS：`pnpm exec tsc --noEmit` 零错误、GetDiagnostics 零问题；
- 端到端：构造"前半 120bpm / 后半 90bpm"脉冲 PCM 直连网关：
  `sequence.bpm` 为主导值、events 中 tempo≥2 条且 time/bpm 正确、beat 在变段后间距变大、
  下载 MIDI 用脚本解析含 2 个 FF51；
- 浏览器：量化栏显示速度段；播放时简谱高亮间距在后半段明显变慢、停止立即静音、控制台无错误；
  单速测试音（C-E-G-C）回归表现与当前一致。

## 七、风险与对策

- **窗口内证据不足导致误切段**：迟滞 + 最短段长 + 八度校正三重约束；回退单段；
- **变段处小节相位错乱**：节拍点跨段递推时沿用 beat/bar 计数，单测覆盖跨段边界；
- **手动 BPM 与检测 map 混用**：UI 明确二态——"自动（map）/ 手动（恒定 map）"，
  切回自动用原始 events 重建；
- **前后端映射实现漂移**：tick/sec 换算公式与 TPQ=480、120 tick/unit 常量共用同一组定义，
  各写各的但用同一组测试向量（0s→0tick、整小节边界、段中插值、末段外推）保证一致。
