/**
 * #1107 最小复现脚本：验证 session_options.intraOpNumThreads 是否生效。
 *
 * 用法：
 *   node scripts/verify-onnx-threads.mjs            # 不传 session_options（修复前行为）
 *   node scripts/verify-onnx-threads.mjs 2          # 传 intraOpNumThreads=2（修复后行为）
 *
 * 判定：脚本启动 onnxruntime session 后，打印进程线程数。
 *   - 修复前：线程数 ≈ 基线 + 物理核数（M 系 ~8-10 个推理线程常驻自旋）
 *   - 修复后：线程数 ≈ 基线 + 2
 * macOS 用 `ps -M <pid> | wc -l` 数线程，脚本自动调 ps 拿自己。
 */
import { execSync } from "node:child_process";

const intraOp = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;

function threadCount(label) {
  // macOS ps -M：输出行数 ≈ 线程数 + 固定偏移（绝对口径有偏差，本脚本只看 delta 相对比较）
  const out = execSync(`ps -M ${process.pid} | tail -n +2 | wc -l`).toString().trim();
  console.log(`${label}: ${out} threads`);
  return parseInt(out, 10);
}

const baseline = threadCount("baseline (before onnx load)");

// 最小 onnx 模型：直接建 session 即可触发线程池创建
const ort = await import("onnxruntime-node");
const sessionOptions = intraOp ? { intraOpNumThreads: intraOp } : {};
// 空 buffer 不行，需要一个真实模型——用 transformers.js 的 bge-m3 太重，
// 这里只验证线程池创建行为：session 创建即建池（onnxruntime 行为）。
// 若无现成小模型，退化为：创建 env 级线程池（ort.env.wasm 不适用 node）。
// 实际上 onnxruntime-node 的 InferenceSession.create 需要模型文件。
// 用本地 bge-m3 onnx 模型（项目已下载）：
const modelPath = process.env.BGE_M3_ONNX ?? "models/bge-m3/onnx/model.onnx";

await ort.InferenceSession.create(modelPath, sessionOptions);
const after = threadCount(`after session create (intraOpNumThreads=${intraOp ?? "default"})`);

console.log(`delta: ${after - baseline} threads`);
console.log(
  intraOp
    ? `PASS if delta <= ${intraOp + 2} (allowing small runtime overhead)`
    : "PASS if delta is large (>= physical cores) — demonstrating the unclamped default",
);
