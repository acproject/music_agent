# AI 音乐教学系统 —— 总体开发与改造提示词

## 1. 项目目标

我要开发一个基于 AI Agent 的智能音乐教学系统。

系统采用前后端架构，前端运行在 Web 浏览器中，支持：

- PC
- 平板
- 手机

设备可以通过浏览器调用麦克风进行实时收音。

系统的核心目标不是简单地做一个“音乐聊天机器人”，而是构建一个真正能够：

> **听音乐 → 分析音乐 → 理解问题 → 教学 → 练习 → 再次分析 → 动态调整教学方案**

的 AI 音乐老师。

系统需要逐步支持：

1. 听音识曲
2. 哼唱识曲
3. 音频转 MIDI
4. 音频转乐谱
5. 五线谱生成
6. 简谱生成
7. 识谱教学
8. 视唱训练
9. 音准训练
10. 节奏训练
11. 唱歌分析
12. 乐器演奏分析
13. 演奏错误检测
14. AI 自动生成改进建议
15. AI 自动生成练习内容
16. 根据学生历史表现建立个人音乐能力模型
17. 根据训练结果动态调整课程和练习难度

---

# 2. 核心产品理念

不要把 LLM 当成音乐分析引擎。

必须明确区分：

```text
AI Agent
    ↓
负责理解、规划、教学、决策
```

和：

```text
Music Analysis Engine
    ↓
负责真正的音频 / 音乐分析
```

因此系统应该采用：

```text
                    AI Music Teacher
                           │
                           ▼
                    AI Agent Runtime
                           │
                    Tool Calling
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
    Music Analysis    Music Knowledge    Learning State
       Engine              Base             / Memory
```

LLM 不应该直接从 WAV 音频中“猜测”用户是否跑调。

应该：

```text
Audio
 ↓
Music Analysis Engine
 ↓
Structured Music Data
 ↓
AI Agent
 ↓
教学判断
```

---

# 3. 总体系统架构

建议采用：

```text
┌──────────────────────────────────────────────┐
│                 Web Frontend                 │
│                                              │
│ React / Vue / TypeScript                     │
│                                              │
│ ┌──────────────┐ ┌────────────────────────┐ │
│ │ Music Score  │ │ Real-time Audio View  │ │
│ │ 五线谱/简谱  │ │ 音高/节奏/波形         │ │
│ └──────────────┘ └────────────────────────┘ │
│                                              │
│ Microphone / Audio Capture                   │
└──────────────────────┬───────────────────────┘
                       │
                HTTP / WebSocket
                       │
                       ▼
┌──────────────────────────────────────────────┐
│              AI Music Backend                │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │              AI Agent                    │ │
│ │                                          │ │
│ │ Planner                                  │ │
│ │ Teacher                                  │ │
│ │ Tool Calling                             │ │
│ │ Learning Memory                          │ │
│ └─────────────────────┬────────────────────┘ │
│                       │                      │
│                       ▼                      │
│ ┌──────────────────────────────────────────┐ │
│ │          Music Tool Layer                │ │
│ │                                          │ │
│ │ Pitch Tool                               │ │
│ │ Rhythm Tool                              │ │
│ │ Beat Tool                                │ │
│ │ Tempo Tool                               │ │
│ │ Note Detection Tool                      │ │
│ │ Chord Detection Tool                     │ │
│ │ Key Detection Tool                       │ │
│ │ Audio Separation Tool                    │ │
│ │ Transcription Tool                       │ │
│ │ MIDI Tool                                │ │
│ │ Score Generation Tool                    │ │
│ │ Performance Comparison Tool              │ │
│ └─────────────────────┬────────────────────┘ │
│                       │                      │
│                       ▼                      │
│              Music Analysis Engine          │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
              ┌───────────────────┐
              │ Music Knowledge   │
              │                   │
              │ 乐理知识          │
              │ 曲谱              │
              │ 课程              │
              │ 练习题            │
              │ 音乐知识库        │
              └───────────────────┘
```

---

# 4. 前端要求

前端必须是 Web 技术，并且优先保证：

- PC
- Tablet
- Mobile

三个场景都可以使用。

不要把系统设计成只能使用电脑。

## 4.1 麦克风

使用浏览器标准能力获取：

```text
MediaDevices.getUserMedia()
```

以及：

```text
Web Audio API
```

处理音频。

基本链路：

```text
Microphone
 ↓
WebAudio
 ↓
PCM / AudioBuffer
 ↓
WebSocket
 ↓
Backend
```

需要支持：

- 开始录音
- 停止录音
- 暂停
- 实时音频状态
- 麦克风权限提示
- 输入设备选择
- 音频电平显示
- 网络断开处理

---

# 5. 实时分析

必须设计 Streaming 模式。

实时模式主要用于：

- 唱歌纠错
- 视唱
- 音准训练
- 节奏训练
- 实时演奏分析

目标：

```text
Audio
 ↓
Streaming Analysis
 ↓
Pitch / Beat / Note
 ↓
WebSocket
 ↓
Frontend
```

尽量保证低延迟。

前端应该可以看到：

```text
当前音高
当前音符
当前节拍
当前 BPM
当前目标音符
实际音高
音高偏差
节奏偏差
```

---

# 6. 离线 / 高质量分析模式

实时分析和高质量分析必须分开。

实时模式：

```text
低延迟
优先实时反馈
```

高质量模式：

```text
允许更高延迟
进行更加复杂的分析
```

高质量模式可以：

```text
Audio
 ↓
Noise Reduction
 ↓
Source Separation
 ↓
Pitch Detection
 ↓
Note Detection
 ↓
Beat Detection
 ↓
Tempo
 ↓
Chord
 ↓
Key
 ↓
Structure
 ↓
MIDI
 ↓
MusicXML / Score
```

---

# 7. Music Event 数据模型

系统必须建立统一的音乐事件数据模型。

不要让不同模块使用完全不同的数据格式。

基础 Note Event：

```json
{
  "type": "note",
  "pitch": 60,
  "start": 1.25,
  "duration": 0.48,
  "velocity": 82,
  "confidence": 0.97
}
```

Performance Event：

```json
{
  "type": "performance",
  "target_pitch": 60,
  "actual_pitch": 59.7,
  "target_start": 1.25,
  "actual_start": 1.31,
  "pitch_error": -0.3,
  "timing_error": 0.06
}
```

还需要逐步支持：

```text
NoteEvent
BeatEvent
ChordEvent
TempoEvent
KeyEvent
MeasureEvent
LyricEvent
PerformanceEvent
PitchCurve
DynamicsEvent
```

最终形成统一：

```text
Music Event Model
```

---

# 8. 听音识曲

实现两种模式。

## 8.1 完整音乐识曲

```text
Audio
 ↓
Audio Fingerprint
 ↓
Music Database
 ↓
Candidate Songs
```

返回：

```json
{
  "title": "...",
  "artist": "...",
  "confidence": 0.92
}
```

## 8.2 哼唱识曲

用户可以直接哼唱：

```text
啦啦啦～
```

系统提取：

```text
Melody
 ↓
Pitch Sequence
 ↓
Melody Embedding / Matching
 ↓
Candidate Songs
```

返回候选歌曲，而不是强制返回唯一结果。

---

# 9. 音频转谱

这是系统的核心能力之一。

输入：

```text
用户唱歌
或者
用户演奏
```

输出：

```text
Audio
 ↓
Pitch
 ↓
Note
 ↓
MIDI
 ↓
Score
```

需要支持：

### 五线谱

显示：

```text
Treble Clef
Notes
Rhythm
Measure
Time Signature
Key Signature
```

### 简谱

例如：

```text
1 1 5 5
```

### MIDI

可以导出：

```text
.mid
```

### MusicXML

可以考虑支持：

```text
.musicxml
```

---

# 10. 音高曲线

必须能够显示：

```text
Target Pitch
        ─────────●────────

Actual Pitch
      ╱────●──────╲
```

用户可以直接看到：

- 唱高
- 唱低
- 音准漂移
- 音头偏差
- 音尾下降
- Vibrato

---

# 11. 识谱教学

建立 AI 音乐教师。

例如用户：

> 教我认识五线谱。

Agent 应该：

1. 判断用户水平
2. 选择教学内容
3. 展示乐谱
4. 解释概念
5. 给练习
6. 要求用户回答 / 唱
7. 分析用户表现
8. 自动判断是否进入下一阶段

不要只返回文字。

必须让前端显示：

```text
乐谱
+
动画
+
钢琴键盘
+
音频
+
AI 讲解
```

---

# 12. 视唱训练

系统随机生成或选择乐谱：

```text
Key: C Major
Time Signature: 4/4
Tempo: 80 BPM
```

显示：

```text
𝄞
| ♪ ♪ ♩ | ♩ ♪ ♪ |
```

用户唱歌。

系统实时比较：

```text
Target Note
      ↓
User Pitch
      ↓
Score Following
```

输出：

```text
Pitch Accuracy
Rhythm Accuracy
Timing Accuracy
Completeness
```

例如：

```text
音准       91%
节奏       83%
完整性     94%
```

同时定位：

```text
第 3 小节
第 2 个音
```

---

# 13. 节奏训练

支持：

- 拍手
- 哼唱
- 敲击
- 乐器

分析：

```text
Beat
Onset
Timing Error
Tempo Stability
```

例如：

```text
Beat 1    +12ms
Beat 2    +31ms
Beat 3    -92ms
Beat 4    +18ms
```

AI 根据结果给建议。

例如：

> 第三拍明显提前，建议降低速度到 70 BPM 重新练习。

---

# 14. 唱歌分析

用户上传或者实时演唱。

系统分析：

```text
Pitch
Rhythm
Tempo
Dynamics
Stability
Range
Vibrato
Articulation
```

输出：

```text
音准       82%
节奏       74%
速度稳定性 79%
音域       C3 ~ E5
```

必须避免只给：

> “唱得不好。”

必须定位具体问题：

```text
第 X 小节
第 X 个音
问题类型
偏差
原因解释
训练建议
```

---

# 15. 乐器演奏分析

第一阶段建议优先支持：

```text
钢琴
单音旋律乐器
```

以后扩展：

```text
吉他
小提琴
长笛
其他乐器
```

例如：

```text
Target:

C4 E4 G4 C5

Actual:

C4 E4 F4 C5
       ↑
      错音
```

AI：

> 第三个音应该是 G4，你演奏成了 F4。

进一步可以给出练习：

```text
C4 → E4 → G4 → C5
```

---

# 16. AI Agent Tool Calling

Agent 必须通过工具调用音乐分析能力。

至少设计：

```text
get_current_recording()

analyze_pitch()

analyze_rhythm()

analyze_tempo()

analyze_beat()

detect_notes()

detect_chords()

detect_key()

transcribe_music()

generate_midi()

generate_score()

compare_performance()

analyze_vocal()

analyze_instrument()

generate_exercise()

get_student_profile()

update_student_profile()
```

Agent 不允许伪造分析结果。

如果没有调用相关工具，就不能声称：

> “你第三个音唱低了 30 cents。”

---

# 17. AI Agent 角色

Agent 可以拆成：

```text
Music Teacher Agent
Music Analysis Agent
Exercise Agent
Curriculum Agent
```

第一阶段可以合并为一个 Agent。

后续再拆分。

---

# 18. AI 音乐老师工作流程

典型流程：

```text
用户：
“为什么我唱歌总跑调？”

↓

Agent

↓

get_current_recording()

↓

analyze_pitch()

↓

analyze_rhythm()

↓

analyze_vocal()

↓

得到结构化结果

↓

分析问题

↓

制定训练计划

↓

generate_exercise()

↓

用户练习

↓

再次录音

↓

再次分析

↓

更新 Student Profile
```

形成：

```text
Observe
 ↓
Analyze
 ↓
Teach
 ↓
Practice
 ↓
Evaluate
 ↓
Adapt
```

---

# 19. 个人音乐能力模型

系统需要保存学生长期学习状态。

例如：

```json
{
  "pitch_accuracy": 82,
  "rhythm_accuracy": 91,
  "sight_reading": 68,
  "ear_training": 87,
  "vocal_range": {
    "min": "C3",
    "max": "E5"
  }
}
```

进一步保存：

```text
历史成绩
错误类型
经常出错的小节
经常唱错的音
节奏问题
训练历史
完成课程
练习次数
进步趋势
```

AI Agent 根据这些数据自动制定下一次练习。

---

# 20. 自适应难度

系统不能始终给用户相同难度。

例如：

```text
准确率 > 95%
        ↓
难度 +1

80% ~ 95%
        ↓
保持

准确率 < 80%
        ↓
降低难度
```

节奏也可以：

```text
BPM 60
 ↓
65
 ↓
70
 ↓
75
```

形成自动训练。

---

# 21. 前端音乐工作台

设计一个统一的 Music Workspace。

建议：

```text
┌─────────────────────────────────────────┐
│ AI Music Teacher                        │
├──────────────┬──────────────────────────┤
│              │                          │
│ 学习         │         乐谱             │
│              │                          │
│ 识谱         │       𝄞                  │
│ 视唱         │   ──●──●────            │
│ 节奏         │                          │
│ 听音         │       音高曲线           │
│ 唱歌         │      ╱╲                  │
│ 乐器         │ ────╱──╲────            │
│              │                          │
│              ├──────────────────────────┤
│              │ 🎤 正在聆听              │
│              │                          │
│              │ 音准 █████████░ 91%      │
│              │ 节奏 ████████░░ 84%      │
├──────────────┴──────────────────────────┤
│ AI 老师                                  │
│ 第三小节的第二个音偏低，我们再练一次。   │
└─────────────────────────────────────────┘
```

移动端自动调整为：

```text
乐谱
 ↓
实时音高
 ↓
录音控制
 ↓
分析结果
 ↓
AI 老师
```

---

# 22. 数据存储

建议：

```text
SQLite
```

保存：

```text
Users
Students
Courses
Lessons
Exercises
Recordings
MusicScores
Performances
AnalysisResults
StudentProfiles
LearningHistory
```

大型音频文件不要直接塞进 SQLite。

建议：

```text
SQLite
+
File/Object Storage
```

SQLite 保存 metadata。

---

# 23. API 设计

建议后端提供：

```text
POST /api/audio/session
POST /api/audio/upload

WS   /api/audio/stream

POST /api/music/analyze
POST /api/music/transcribe
POST /api/music/identify

POST /api/performance/analyze

POST /api/lesson/start
POST /api/lesson/continue

POST /api/exercise/generate

GET  /api/student/profile
GET  /api/student/history
```

AI Agent 通过内部 Tool API 调用音乐能力。

---

# 24. WebSocket 实时消息

设计统一协议。

例如：

```json
{
  "type": "pitch",
  "timestamp": 1.23,
  "frequency": 261.6,
  "midi": 60,
  "confidence": 0.97
}
```

节拍：

```json
{
  "type": "beat",
  "timestamp": 2.41,
  "beat": 3,
  "bar": 2
}
```

音符：

```json
{
  "type": "note",
  "pitch": 60,
  "start": 1.2,
  "duration": 0.5
}
```

分析结果：

```json
{
  "type": "analysis",
  "pitch_accuracy": 0.91,
  "rhythm_accuracy": 0.83
}
```

---

# 25. 音乐知识库

建立 Music Knowledge Base。

内容包括：

```text
音乐基础知识
五线谱
简谱
音名
唱名
音程
和弦
调式
调性
节奏
拍号
速度
力度
音乐术语
声乐知识
乐器知识
```

同时建立：

```text
课程
练习题
示范音频
示范 MIDI
示范乐谱
```

Agent 使用 RAG 查询知识。

---

# 26. 练习生成

AI 不应该只生成文字练习。

应该生成结构化 Exercise：

```json
{
  "type": "sight_singing",
  "key": "C",
  "tempo": 70,
  "time_signature": "4/4",
  "difficulty": 2,
  "notes": [
    60,
    62,
    64,
    67
  ]
}
```

然后前端：

```text
Exercise
 ↓
Score Renderer
 ↓
Audio/MIDI
 ↓
User Performance
 ↓
Analysis
```

---

# 27. 第一阶段 MVP

不要一开始实现所有功能。

第一阶段只实现：

```text
浏览器麦克风
      ↓
实时音频
      ↓
Pitch Detection
      ↓
Note Detection
      ↓
MIDI
      ↓
五线谱 / 简谱
      ↓
实时音高曲线
      ↓
目标音符 vs 实际音符
      ↓
基础 AI 反馈
```

必须先把这一条链路完整跑通。

---

# 28. 第二阶段

加入：

```text
节奏分析
BPM
Beat
Onset
Tempo Stability
```

实现：

```text
节奏训练
拍手训练
视唱训练
```

---

# 29. 第三阶段

加入：

```text
AI 音乐教师
课程系统
练习系统
Student Profile
Learning Memory
```

实现：

```text
学习
 ↓
练习
 ↓
分析
 ↓
评价
 ↓
生成下一次练习
```

---

# 30. 第四阶段

加入：

```text
歌曲识别
哼唱识曲
高质量音频转谱
MusicXML
MIDI
Chord
Key
```

---

# 31. 第五阶段

加入：

```text
钢琴分析
乐器演奏分析
多乐器
高级演奏评价
```

---

# 32. 第六阶段

实现完整 AI Music Teacher：

```text
学生
 ↓
AI 评估
 ↓
学习计划
 ↓
课程
 ↓
练习
 ↓
实时分析
 ↓
错误诊断
 ↓
个性化训练
 ↓
历史能力模型
 ↓
动态调整课程
```

---

# 33. AI Coder 执行要求

如果这是对一个已有代码项目进行改造，请不要直接开始大规模修改。

必须按照以下顺序执行：

### Step 1：分析现有项目

检查：

```text
目录结构
前端框架
后端框架
通信方式
已有 AI 接口
已有数据库
已有音频模块
已有 UI
已有测试
```

输出：

```text
Current Architecture
```

---

### Step 2：建立 Gap Analysis

比较：

```text
现有能力
vs
本提示词要求
```

生成：

```text
Implemented
Missing
Partial
Need Refactor
Need New Module
```

---

### Step 3：制定改造计划

不要一次修改整个项目。

按照：

```text
Phase
 ↓
Module
 ↓
Interface
 ↓
Implementation
 ↓
Test
```

逐步实施。

---

### Step 4：优先建立底层数据模型

优先完成：

```text
MusicEvent
NoteEvent
BeatEvent
PerformanceEvent
AnalysisResult
Exercise
StudentProfile
```

再开发 UI。

---

### Step 5：建立 Music Tool API

优先：

```text
PitchTool
RhythmTool
NoteTool
TempoTool
ScoreTool
PerformanceTool
```

保证 Agent 后续可以调用。

---

### Step 6：建立 AI Agent

Agent 必须通过 Tool Calling 工作。

禁止：

```text
LLM 自己假装分析音频
```

必须：

```text
Agent
 ↓
Tool
 ↓
Structured Result
 ↓
Reasoning
 ↓
Teaching Response
```

---

# 34. 重要架构原则

## 原则 1

不要把音乐分析逻辑全部写在前端。

前端负责：

```text
录音
显示
交互
可视化
```

后端负责：

```text
音乐分析
AI
数据
课程
用户状态
```

---

## 原则 2

实时数据必须支持 WebSocket。

不要把实时音频分析设计成：

```text
录完
上传
等待
返回
```

实时教学必须：

```text
Streaming
```

---

## 原则 3

LLM 与音乐分析引擎解耦。

未来可以替换：

```text
OpenAI
Qwen
Gemma
MiniMax
本地 LLM
```

而不影响：

```text
Pitch
Rhythm
MIDI
Score
```

---

## 原则 4

音乐数据必须结构化。

不要只保存：

```text
“用户唱得不准”
```

而应该保存：

```text
pitch_error
timing_error
note
measure
timestamp
confidence
```

这样以后才能重新分析。

---

## 原则 5

所有分析结果都必须可解释。

例如：

错误：

> 你这里唱得不好。

正确：

> 第 3 小节第 2 个音目标是 G4，你实际演唱约为 F#4，平均偏低约 1 个半音。

---

# 35. 最终目标

最终系统应该成为：

```text
                 AI Music Teacher
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
      学                 听                 演
       │                 │                 │
      识谱              听音               唱歌
      乐理              识曲               乐器
      节奏              转谱               演奏
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
                  Music Analysis
                         │
                    AI Evaluation
                         │
                  Personalized Plan
                         │
                      Practice
                         │
                    Re-evaluation
                         │
                    Student Model
```

最终形成：

> **听 → 看 → 学 → 唱/弹 → 分析 → 纠错 → 练习 → 再分析**

的完整 AI 音乐教育闭环。

---

# 36. 当前开发任务

现在不要一次性实现全部功能。

首先完成：

```text
Phase 1 MVP
```

目标：

```text
Browser Microphone
        ↓
Audio Stream
        ↓
Backend
        ↓
Pitch Detection
        ↓
Note Detection
        ↓
Music Event
        ↓
MIDI / Score
        ↓
Frontend Visualization
        ↓
AI Agent
        ↓
Basic Music Feedback
```

完成后再进入 Rhythm、Sight Singing、Vocal Analysis、Instrument Analysis 和 Personalized Learning。

在修改代码之前，先输出：

1. 当前项目架构
2. 当前已有能力
3. 与本需求的差距
4. 建议新增的模块
5. 建议修改的模块
6. 数据模型设计
7. API 设计
8. WebSocket 设计
9. Agent Tool 设计
10. Phase 1 实施计划

**不要在没有分析现有项目的情况下直接重构。**

如果发现现有架构已经存在类似能力，优先复用，而不是重复实现。

所有新增代码必须保持模块化，避免将 AI、音频、音乐分析、数据库和 UI 强耦合。

最终目标是建立一个可以持续扩展的 AI Music Agent 平台，而不是只完成一个 Demo。