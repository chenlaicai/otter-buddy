/**
 * write-verdict：终局裁决（judge 考试判据，F20261013gev2）。
 *
 * mode=positive：求值成功并按落点/正向证明得出终局结论；mode=fail-closed：求值不出/不可证
 * （§3.3 读不出终局）——BLOCK 是 v2 的终局态，残余面（residual_face）即以此态如实钉 BLOCK。
 * 「judge 考试」（guard-touchstone-exam）与影子投影同用本判据，口径不得分叉。
 */
import type { WriteTarget, UnevalReason, WriteEvalResult, ScriptPayloadInfo } from "./write-target-evaluator";
import { evaluateWriteTargets, pathWithinMain } from "./write-target-evaluator";

export type WriteVerdictResult =
  | { verdict: "ALLOW"; mode: "positive"; targets: WriteTarget[] }
  | { verdict: "BLOCK"; mode: "positive"; targets: WriteTarget[]; mainHits: WriteTarget[] }
  | { verdict: "BLOCK"; mode: "fail-closed"; reason: UnevalReason };

/** 终局裁决（纯函数）：bash 命令写判定的 v2 判据——
 *  · evaluated 且写落点 ∩ 主仓树内 → BLOCK（positive，落点证据）
 *  · evaluated 且写落点 ∩ 主仓树内 = ∅ → ALLOW（positive，含证明无写/只读披露）
 *  · unevaluated → BLOCK（fail-closed，§3.3）
 *  只读披露（access=read）不构成写证据（能力 8/证明演算规则 3）。 */
export function evaluateWriteVerdict(command: string, projectRoot: string, startCwd: string = projectRoot, scriptPayload?: ScriptPayloadInfo): WriteVerdictResult {
  const r = evaluateWriteTargets(command, projectRoot, startCwd, scriptPayload);
  if (r.kind === "unevaluated") return { verdict: "BLOCK", mode: "fail-closed", reason: r.reason };
  const mainHits = r.targets.filter(t => t.access === "write" && pathWithinMain(t.path, projectRoot));
  if (mainHits.length > 0) return { verdict: "BLOCK", mode: "positive", targets: r.targets, mainHits };
  return { verdict: "ALLOW", mode: "positive", targets: r.targets };
}

export type { WriteEvalResult, ScriptPayloadInfo };
