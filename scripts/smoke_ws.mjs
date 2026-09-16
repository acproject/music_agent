// M1 WebSocket 协议级端到端冒烟（Node 24 内置 WebSocket，无需第三方依赖）。
//
// 验证链路：Node 客户端 → Rust 网关 → Python gRPC StreamAudio → 回流 JSON。
// 用法：node scripts/smoke_ws.mjs [ws://127.0.0.1:8080/api/audio/stream]

const URL = process.argv[2] ?? 'ws://127.0.0.1:8080/api/audio/stream';
const FRAME_BYTES = 640 * 4; // 40ms @ 16kHz Float32
const timeoutMs = 6000;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

function once(ws, predicate, timeout = timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error('等待消息超时'));
    }, timeout);
    const onMsg = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        resolve(msg);
      }
    };
    ws.addEventListener('message', onMsg);
  });
}

async function main() {
  console.log(`→ 连接 ${URL}`);
  const ws = new WebSocket(URL);
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('连接失败（Rust 网关是否已启动？）')));
  });
  await opened;

  // 0) 未握手先发二进制 → not_ready 错误
  ws.send(new Uint8Array(16).buffer);
  const notReady = await once(ws, (m) => m.type === 'error' && m.code === 'not_ready');
  check('未 hello 发二进制被拒绝', notReady.code === 'not_ready');

  // ping/pong
  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await once(ws, (m) => m.type === 'pong');
  check('ping → pong', pong.type === 'pong');

  // 1) 握手
  ws.send(JSON.stringify({ type: 'hello', sample_rate: 16000, channels: 1, mode: 'streaming' }));
  const ready = await once(ws, (m) => m.type === 'ready');
  check('hello → ready', ready.type === 'ready');
  check('ready 携带 session_id', typeof ready.session_id === 'string' && ready.session_id.length > 0,
    `got=${ready.session_id}`);
  check('ready 回协商采样率 16000', ready.sample_rate === 16000);
  console.log(`    session=${ready.session_id}`);

  // 2) 发送 6 帧相位连续的 440Hz 正弦 + 3 帧静音，验证真实 YIN 音高检测
  const SR = 16000;
  const N = 640;
  const events = [];
  const collect = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === 'pitch') events.push(msg);
  };
  ws.addEventListener('message', collect);

  let phase = 0;
  const toneFrame = (freq) => {
    const frame = new Float32Array(N);
    for (let i = 0; i < N; i += 1) {
      frame[i] = 0.3 * Math.sin(phase);
      phase += (2 * Math.PI * freq) / SR;
    }
    return frame;
  };

  for (let i = 0; i < 6; i += 1) ws.send(toneFrame(440).buffer);
  for (let i = 0; i < 3; i += 1) ws.send(new Float32Array(N).buffer);

  await new Promise((res) => setTimeout(res, 1200));
  ws.removeEventListener('message', collect);

  check('收到 9 个回流 pitch 事件（6 乐音 + 3 静音）', events.length === 9, `got=${events.length}`);
  check('事件 source=realtime', events.every((e) => e.source === 'realtime'));

  const tones = events.slice(0, 6);
  const silences = events.slice(6);
  const voicedTones = tones.filter((e) => e.voiced === true);
  check('6 帧 440Hz 中至少 5 帧 voiced', voicedTones.length >= 5, `voiced=${voicedTones.length}`);
  const inTune = voicedTones.filter(
    (e) => Math.abs(e.frequency_hz - 440) / 440 < 0.02,
  ).length;
  check('voiced 帧频率误差 < 2%（440Hz）', inTune >= 5,
    `freqs=${voicedTones.map((e) => e.frequency_hz.toFixed(1)).join(',')}`);
  check('voiced 帧置信度 > 0.5', voicedTones.every((e) => e.confidence > 0.5));
  check('静音帧全部 unvoiced', silences.every((e) => e.voiced === false),
    `voiced=${silences.filter((e) => e.voiced).length}`);
  check(
    '时间戳按 40ms 累积',
    events.length === 9 &&
      events[0].timestamp === 0 &&
      Math.abs(events[8].timestamp - 0.32) < 1e-6,
    `last=${events.at(-1)?.timestamp}`,
  );

  // 3) stop 正常收尾
  ws.send(JSON.stringify({ type: 'stop' }));
  const stopped = await once(ws, (m) => m.type === 'stopped');
  check('stop → stopped', stopped.type === 'stopped');
  ws.close();

  console.log(failures === 0 ? '\nSMOKE_OK' : `\nSMOKE_FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
