# 两个训练面板（视唱训练 / 节奏训练）实施计划

## Repository Research

现有训练能力只有 M7 的 [SightSingingPanel.tsx](file:///d:/workspace/rust_projects/music_agent/apps/web/src/components/SightSingingPanel.tsx)：走 WebSocket 实时链路，靠 [ScoreFollower](file:///d:/workspace/rust_projects/music_agent/apps/web/src/domain/scoreFollower.ts) 增量对齐。本次要新增的是**离线链路**的两个面板：规则生成结构化练习 → 录音 → 比较层评分 → 小节级反馈。

可复用资产：

- [comparePerformance.ts](file:///d:/workspace/rust_projects/music_agent/apps/web/src/domain/comparePerformance.ts)：对齐 + 评分核心，`mode: 'sight_singing' | 'rhythm'` 已就绪；rhythm 模式忽略音高；支持 `actualOffsetSec` 平移实际起音（预备拍场景）；`adaptiveOnsetWindowSec` 自适应对齐窗。
- [analyze.ts](file:///d:/workspace/rust_projects/music_agent/apps/web/src/api/analyze.ts)：`analyzeAudio(pcm, {pipeline:['notes']})` 整段 PCM 上传，返回 `NoteDto[]`。
- [AudioCapture.ts](file:///d:/workspace/rust_projects/music_agent/apps/web/src/audio/AudioCapture.ts)：16kHz 单声道 40ms 帧；TranscribePanel 已有"攒 chunk → concat → analyze"模式。
- [quantize.ts](file:///d:/workspace/rust_projects/music_agent/apps/web/src/domain/quantize.ts)：`QuantizedScore` / `ScoreMeasure` / `ScoreItem` 数据结构与 `decomposeUnits`；4/4 每小节 16 个 16 分网格单元。
- [StaffScore.tsx](file:///d:/workspace/rust_projects/music_agent/apps/web/src/components/StaffScore.tsx)：VexFlow 渲染 QuantizedScore（Voice 硬编码 4/4），目前只支持单个 activeItem 高亮，需扩展逐音着色。
- [scorePlayer.ts](file:///d:/workspace/rust_projects/music_agent/apps/web/src/audio/scorePlayer.ts)：`play(tracks, tempoMap, handlers)`，可用于"听示范"。
- [tempoMap.ts](file:///d:/workspace/rust_projects/music_agent/apps/web/src/domain/tempoMap.ts)：`constantTempoMap(bpm)`、`unitsToSec`、`secToUnits`。

关键约束（决定设计）：

1. **不能用 `targetNotesFromScore` 展开节奏练习**：它会合并相邻同音高条目（`last.midi === item.midi`）。节奏拍手全部记谱为同一音高（如 MIDI 60），连续八分/十六分点会被合并成一次起音。→ Exercise 模块直接构建 `TargetNote[]`，每个网格音都是独立 attack；视唱练习同样保留同音高反复（do-do）为两次起音。
2. **生成时值限定为单条目时值**：units ∈ {1,2,3,4,6,8,12,16}（DURATION_TABLE 单行可表达），保证一个攻击 = 一个 ScoreItem，StaffScore 内"小节内第 n 个音符"的计数与 `TargetNote.noteIndex` 严格一致；切分节奏用"弱拍起 + 休止/跨小节摆放"实现，不用 7、5 等需分解的长度。
3. 仅支持 4/4（StaffScore Voice 硬编码 numBeats:4），不改动此边界。
4. 生成器必须可注入 RNG（mulberry32 种子），保证测试确定性 + "换一条"随机刷新。

## Files and Modules

新增：

- `apps/web/src/domain/exercise.ts`：`Exercise` 模型、种子 RNG、两类型 × 3 难度的规则生成器；输出 QuantizedScore + TargetNote[] + 示范用轨道数据。
- `apps/web/src/domain/exercise.test.ts`：生成不变量（每小节 16 单元、时值白名单、音域/跳进约束、种子可复现）。
- `apps/web/src/domain/measureFeedback.ts`：按小节聚合 PerformanceReport，重算每小节得分，生成规则文案。
- `apps/web/src/domain/measureFeedback.test.ts`：漏/错/抢/拖/偏高等场景的文案与分组。
- `apps/web/src/audio/metronome.ts`：抽出 `playCountIn(ctx, bpm, beats)`（现内联在 SightSingingPanel，不改动原面板，新面板使用新工具）。
- `apps/web/src/components/useTrainingSession.ts`：共享 hook（听示范、预备拍 + 录音、停止 → 分析 → 比较 → 小节反馈）。
- `apps/web/src/components/TrainingReportView.tsx`：共享报告视图（总评指标 + 着色五线谱 + 逐小节卡片：得分、逐音 chips、文案、杂声）。
- `apps/web/src/components/SightReadingTrainer.tsx`：视唱训练面板（薄壳）。
- `apps/web/src/components/RhythmTrainer.tsx`：节奏训练面板（薄壳）。

修改：

- `apps/web/src/components/StaffScore.tsx`：新增 `noteColors?: Map<string, string>`（key=`小节:小节内音符序号`，1 基），给对应音符 setStyle；保留 activeItem。
- `apps/web/src/App.tsx`：挂载两个新面板；hero 副标题更新为 M8。
- `apps/web/src/styles.css`：训练控件、小节卡片、chip 状态色（ok/late/early/wrong/missing/extra）。
- `README.md`：追加 M8 里程碑段落。

## Implementation Steps

1. **exercise.ts**
   - `type ExerciseKind = 'sight_singing' | 'rhythm'`；`interface Exercise { kind; level: 1|2|3; bpm; title; score: QuantizedScore; targets: TargetNote[] }`。
   - RNG：`createRng(seed: number)`（mulberry32），`randInt` / `pick` / `shuffle`。
   - 节奏细胞表（按难度）：
     - L1：{1,2,4,8,16} 音符/休止，只在强拍位放休止；
     - L2：加入 3（附点八）、6（附点四）、八分音组；
     - L3：加入 1（十六分）、弱拍起、八分休止造成的切分。
     - `generateBarPattern(level, rng)`：贪心/回溯选取细胞填满 16 单元。
   - 节奏练习：pattern → ScoreItem（音符统一 MIDI 60 记谱）。
   - 视唱练习：先取节奏骨架（节奏细胞表的子集，L1 无休止 / L2 允许附点与四分休止 / L3 十六分与切分），再按规则配唱名：
     - C 大调；音域 L1: C4–A4 仅级进（音程 ≤2 度），L2: G3–E5 允许 ≤5 度跳进且跳进后反向级进，L3: E3–G5 允许任意跳进但大跳后须回落；首音 L1/L2 从主和弦音起；
     - contour 随机游走 + 约束回退（生成不合法则重采，限次）。
   - 组装：`ScoreMeasure{startUnit: i*16, items}`（直接按单位查时值表，不做二次分解）；`tempoMap = constantTempoMap(bpm)`；`targets` 由网格经 `unitsToSec` 直接构建（measure/noteIndex/globalIndex 同步计数，休止不占 noteIndex）。
   - `generateExercise(kind, level, opts?: {bpm?, seed?})`；小节数固定 4；BPM 选项 L1 [60,80,100]、L2/L3 [60,80,100,120]。
2. **measureFeedback.ts**
   - `MeasureFeedback { measure; score; matched; missingCount; extraCount; pitchAccuracy; timingAccuracy; meanAbsTimingMs; comments: string[] }`。
   - events 按 measure 分组；extras 用 `secToUnits(onset - offsetSec, tempoMap)` 折算到最近小节（越界夹到首/末小节）。
   - 每小节按 mode 权重（复用 MODE_DEFAULTS 口径：pitch/timing/completeness）独立重算综合分，missing 计入本小节完整度。
   - 逐音规则文案（按 noteIndex 排序，一条音最多两条：音准类 + 节奏类）：
     - missing：`第 n 音漏唱` / `漏拍`；
     - wrongNote（仅视唱）：`第 n 音唱成 {actualName}，应为 {targetName}`；
     - 节奏：`第 n 音抢拍/拖后 {ms}ms`（|err|>timingTol）；
     - 音准（非错音但超 50¢）：`第 n 音偏高/偏低 {cents} 音分`；
     - extras：`多出 x 个杂声/抢拍音`。
   - 小节总评：score≥0.9 `完成得很好`；0.7–0.9 `基本稳定，注意…`；<0.7 `建议放慢速度单独重练本小节`。
3. **metronome.ts**：`playCountIn(ctx, bpm, beats=2)`，逻辑照搬 SightSingingPanel（末拍高音）。
4. **StaffScore.tsx 扩展**：构建 tickable 时维护"小节内已见音符数"，查 `noteColors.get('${measure+1}:${noteNo}')` 命中即 `setStyle({fillStyle, strokeStyle})`；rest 不计数。
5. **useTrainingSession.ts**
   - `phase: 'idle'|'recording'|'analyzing'|'done'` + `error`、`recordSec`、`report`、`measureFeedback`、`demoPlaying`。
   - `playDemo(exercise)`：从 score.measures 抽全部 note items 组单轨（program=0 钢琴；节奏面板同），ScorePlayer 播放，onEnd 复位。
   - `start(exercise)`：建 AudioCapture，chunksRef 累积；permission granted 后 `playCountIn`；预备拍结束即进入录音轴（offsetSec = 2·beat）。
   - `stop()`：停采集 → concatChunks → `analyzeAudio(pcm,{pipeline:['notes']})` → `comparePerformance(targets, notes,{mode: kind, actualOffsetSec: offsetSec})` → `buildMeasureFeedback`。
   - 卸载清理（capture/socket 无 socket，player 停）。
6. **TrainingReportView.tsx**：总评指标条（综合分/完整度/音准/节奏/错漏多）→ StaffScore（noteColors 由 events 状态映射：ok 绿、early/late 琥珀、wrong 红、missing 在谱面无对应 item 不染色而在小节卡展示）→ 逐小节卡片（得分 badge、chips：每个 target 一 chip 带状态色与偏差值、missing chip、extra chip、comments 列表）。
7. **SightReadingTrainer.tsx / RhythmTrainer.tsx**：控件（难度 select、BPM select、`换一条`（随机新种子）、`听示范`、`开始录音（2 拍预备）/结束并评分`）、未录音时展示谱面预览、完成后渲染 TrainingReportView；两组件仅文案/默认 BPM/kind 不同。
8. **App.tsx** 挂载（置于 M7 面板之后）；**styles.css**；**README.md** M8 段。

## Dependencies and Considerations

- 无需后端改动：analyze 接口 pipeline=`notes` 即可；引擎当前 CREPE/YIN 均可。
- 拍手/敲击的音高不可信但 rhythm 模式不参评；检测端切音对冲击声通常敏感，若出现漏检在 README 注明（靠近麦克风、力度充分）。
- 预备拍咔哒若由扬声器外放可能被录入：平移后落在负时间轴，成为 extras；UI 建议戴耳机（沿用 M7 经验）。
- 种子 RNG 保证同种子生成可复现；"换一条"用 `Date.now()` 或计数器作种子。
- Exercise 为 4 小节固定长度；bpm 变化只改 tempoMap，网格结构不变。

## Validation

- `pnpm test`（apps/web，vitest）：新增 exercise / measureFeedback 测试，且现有 55+ 用例不回归。
- `pnpm tsc --noEmit`（或 package.json 既有 typecheck 脚本）零错误；`pnpm build` 通过。
- 浏览器冒烟（网关 + Python 引擎在线）：两种面板各难度可生成、每小节填满、听示范出声、走一次完整录音→评分→小节反馈；核对芯片颜色与文案、综合分一致性（小节聚合口径 = 总报告口径）。
- 不可用环境下错误路径有中文提示（麦克风拒绝、引擎 503）。

## Risks

- **生成器约束求解失败**（合法旋律采不到）：重采限次 + 兜底返回 L1 级进音阶旋律，保证不抛异常。
- **拍手 onset 检测质量差**：属检测端能力边界；面板保留实际检测数可见，README 给出录音建议；不为此改算法。
- **StaffScore 逐音计数错位**（时值表误用导致一攻击多 item）：测试断言"每个 ScoreItem 与 target 一一对应"；生成时值白名单在单测固化。
- **范围蔓延**（拍号/多调式/LLM 生成）：本期锁定 4/4、C 大调、纯规则；LLM 生成留作后续，不预埋半成品。
