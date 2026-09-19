import TrainerShell from './TrainerShell';

// M8 视唱训练面板：规则生成结构化旋律练习 → 录音 → 比较层评分 → 小节级反馈。

export default function SightReadingTrainer() {
  return (
    <TrainerShell
      config={{
        kind: 'sight_singing',
        title: 'M8 视唱训练 · 结构化练习',
        badge: '练习由规则按难度随机生成（4/4、C 大调、4 小节）；评分与反馈全部离线规则化，不依赖 LLM。',
        description:
          '选定难度后生成一条 4 小节旋律：先听示范熟悉音高，再跟 2 拍预备拍演唱。结束后按小节给出音准、节奏评分，逐音着色并标注抢拍/拖后、错音、漏唱。',
        defaultBpm: 80,
      }}
    />
  );
}
