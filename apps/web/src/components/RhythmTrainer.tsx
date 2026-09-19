import TrainerShell from './TrainerShell';

// M8 节奏训练面板：规则生成结构化节奏练习 → 拍手/敲击录音 → 比较层只评时间 → 小节级反馈。

export default function RhythmTrainer() {
  return (
    <TrainerShell
      config={{
        kind: 'rhythm',
        title: 'M8 节奏训练 · 结构化练习',
        badge: '节奏型由规则按难度随机生成（4/4、4 小节）；只评时间不评音高，评分与反馈全部离线规则化。',
        description:
          '选定难度后生成一条 4 小节节奏型：先听示范记住律动，再跟 2 拍预备拍拍手或敲击。结束后按小节给出节奏准确度，逐音标注抢拍/拖后、漏拍与多音。',
        defaultBpm: 100,
      }}
    />
  );
}
