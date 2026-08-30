import { describe, it, expect } from "vitest";
import { silkToWav } from "@frameworks/weixin/silk-transcode";
import { encode } from "silk-wasm";

/**
 * SILK → WAV 转码测试（issue #567）。
 * 用 silk-wasm encode 真编码一小段 PCM → 解码 roundtrip 验证容器头。
 */

describe("silkToWav", () => {
  it("silk → wav roundtrip：WAV 头字段正确（mono 16bit 24kHz）", async () => {
    // 24000Hz * 0.5s = 12000 samples，16bit → 24000 bytes PCM
    const pcm = Buffer.alloc(24000);
    for (let i = 0; i < pcm.length; i += 2) {
      pcm.writeInt16LE(Math.sin(i / 100) * 8000, i); // 正弦波
    }
    const { data } = await encode(pcm, 24000);
    const silkBuf = Buffer.from(data);

    const wav = await silkToWav(silkBuf);
    expect(wav).not.toBeNull();
    // WAV 容器头断言
    expect(wav!.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav!.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav!.readUInt16LE(20)).toBe(1); // PCM format
    expect(wav!.readUInt16LE(22)).toBe(1); // mono
    expect(wav!.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav!.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav!.length).toBeGreaterThan(44 + 1000); // 有实际数据
  });

  it("非 SILK 输入：返回 null（降级存原始字节由调用方兜底）", async () => {
    const notSilk = Buffer.from("this is definitely not silk data at all");
    const wav = await silkToWav(notSilk);
    expect(wav).toBeNull();
  });
});
