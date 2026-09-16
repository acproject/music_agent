// 麦克风采集 AudioWorklet（浏览器原生模块，不经打包）。
//
// 职责：多声道混合为单声道 → 线性重采样到 16kHz → 按 40ms(640 采样) 分帧，
// 通过 port 把 PCM ArrayBuffer（零拷贝 transfer）与电平回传主线程。
//
// 约定与 crates/audio、services/analysis 完全一致：
//   16000 Hz · 单声道 · Float32 LE · 640 samples/frame(40ms)

const TARGET_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 640; // 16000 * 0.04

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // AudioContext 实际采样率通常为 44100/48000；每输出一个目标采样需要的源采样步长
    this.ratio = (globalThis.sampleRate || TARGET_SAMPLE_RATE) / TARGET_SAMPLE_RATE;
    this.sourceRate = globalThis.sampleRate || TARGET_SAMPLE_RATE;
    this.residual = new Float32Array(0); // 跨 render quantum 残留的源采样
    this.frac = 0; // 下一个输出采样在残留缓冲中的分数位置
    this.frame = new Float32Array(FRAME_SAMPLES);
    this.filled = 0;
    this.enabled = true;

    // 暂停/恢复只停止数据下发，不释放音频图（保证恢复零延迟）
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.type === 'set-enabled') {
        this.enabled = Boolean(data.enabled);
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    const quantum = 128;

    // 1) 多声道混单声道；无输入（设备未给数据）时按静音处理
    let mono;
    if (input && input.length > 0 && input[0]) {
      const channels = input.length;
      const n = input[0].length;
      mono = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          sum += input[c][i];
        }
        mono[i] = sum / channels;
      }
    } else {
      mono = new Float32Array(quantum);
    }

    // 2) RMS 电平（0..1），供主线程画音量条
    let energy = 0;
    for (let i = 0; i < mono.length; i++) {
      energy += mono[i] * mono[i];
    }
    const level = Math.sqrt(energy / mono.length);

    if (this.enabled) {
      // 3) 拼入上次残留，做带分数位置的线性插值重采样
      const buf = new Float32Array(this.residual.length + mono.length);
      buf.set(this.residual, 0);
      buf.set(mono, this.residual.length);

      let srcPos = this.frac;
      let postedLevelThisQuantum = false;
      while (srcPos <= buf.length - 1 && this.enabled) {
        const i = Math.floor(srcPos);
        const f = srcPos - i;
        const s = i + 1 < buf.length ? buf[i] + (buf[i + 1] - buf[i]) * f : buf[i];
        this.frame[this.filled++] = s;
        srcPos += this.ratio;

        if (this.filled === FRAME_SAMPLES) {
          this.port.postMessage(
            { type: 'frame', pcm: this.frame.buffer, level, sourceRate: this.sourceRate },
            [this.frame.buffer],
          );
          postedLevelThisQuantum = true;
          this.frame = new Float32Array(FRAME_SAMPLES);
          this.filled = 0;
        }
      }

      // 未凑满一帧时也持续回传电平，音量条不会"卡顿"
      if (!postedLevelThisQuantum) {
        this.port.postMessage({ type: 'level', level });
      }

      // 4) 保留未消费的源采样与分数偏移，供下一个 quantum 连续重采样
      const consumed = Math.floor(srcPos);
      this.residual = consumed < buf.length ? buf.slice(consumed) : new Float32Array(0);
      this.frac = srcPos - consumed;
    }

    return true; // 保持 processor 存活
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
