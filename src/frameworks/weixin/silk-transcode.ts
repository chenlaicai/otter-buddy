/**
 * SILK 语音解码（issue #567，平移自 openclaw-weixin media/silk-transcode.ts，MIT）。
 *
 * 微信语音入站为 SILK 编码（voice_item.encode_type=6）。多模态管线侧消费
 * WAV/音频文件，故解码为 PCM 后包 WAV 容器。silk-wasm 动态 import：
 * 未安装/解码失败返回 null，调用方降级存原始 SILK（文本转写仍可用）。
 */

const SILK_SAMPLE_RATE = 24_000;

/** PCM s16le 单声道 → WAV 容器（头部字段写入拆小函数控语句数） */
function pcmBytesToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const pcmBytes = pcm.byteLength;
  const totalSize = 44 + pcmBytes;
  const buf = Buffer.allocUnsafe(totalSize);
  writeWavHeader(buf, totalSize, sampleRate);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 44);
  return buf;
}

/** 44 字节标准 WAV 头（RIFF/WAVE/fmt/data 四段；u16/u32 字段用表驱动写减少语句数） */
function writeWavHeader(buf: Buffer, totalSize: number, sampleRate: number): void {
  buf.write("RIFF", 0);
  buf.writeUInt32LE(totalSize - 8, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  const fields: Array<[number, number, number]> = [
    // [offset, size(bytes), value] —— fmt chunk 静态字段 + 采样率相关字段
    [16, 4, 16], // fmt chunk size
    [20, 2, 1], // PCM format
    [22, 2, 1], // mono
    [24, 4, sampleRate],
    [28, 4, sampleRate * 2], // byte rate (mono 16-bit)
    [32, 2, 2], // block align
    [34, 2, 16], // bits per sample
  ];
  for (const [offset, size, value] of fields) {
    if (size === 2) buf.writeUInt16LE(value, offset);
    else buf.writeUInt32LE(value, offset);
  }
  buf.write("data", 36);
  buf.writeUInt32LE(totalSize - 44, 40);
}

/** SILK → WAV。失败返回 null（调用方降级存原始 SILK） */
export async function silkToWav(silkBuf: Buffer): Promise<Buffer | null> {
  try {
    const { decode } = await import("silk-wasm");
    const result = await decode(silkBuf, SILK_SAMPLE_RATE);
    return pcmBytesToWav(result.data, SILK_SAMPLE_RATE);
  } catch {
    return null;
  }
}
