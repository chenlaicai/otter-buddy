/**
 * write-verdict：终局裁决（judge 考试判据，F20261013gev2）。
 *
 * mode=positive：求值成功并按落点/正向证明得出终局结论；mode=fail-closed：求值不出/不可证
 * （§3.3 读不出终局）——BLOCK 是 v2 的终局态，残余面（residual_face）即以此态如实钉 BLOCK。
 * 「judge 考试」（guard-touchstone-exam）与影子投影同用本判据，口径不得分叉。
 */
import type { WriteTarget, UnevalReason, WriteEvalResult, ScriptPayloadInfo } from "./write-target-evaluator";
import { evaluateWriteTargets, pathWithinMain, pathEntryWithinMain, isUntrackedProbeDebris, debrisRmAllowPath } from "./write-target-evaluator";

export type WriteVerdictResult =
  | { verdict: "ALLOW"; mode: "positive"; targets: WriteTarget[] }
  | { verdict: "BLOCK"; mode: "positive"; targets: WriteTarget[]; mainHits: WriteTarget[] }
  | { verdict: "BLOCK"; mode: "fail-closed"; reason: UnevalReason };

/** 终局裁决（纯函数）：bash 命令写判定的 v2 判据——
 *  · evaluated 且写落点 ∩ 主仓树内 → BLOCK（positive，落点证据）
 *  · evaluated 且写落点 ∩ 主仓树内 = ∅ → ALLOW（positive，含证明无写/只读披露）
 *  · unevaluated → BLOCK（fail-closed，§3.3）
 *  只读披露（access=read）不构成写证据（能力 8/证明演算规则 3）。
 *  F20261029clnup：entryOp（rm 等目录项删除语义）落点为「主仓根未跟踪探针残渣文件」时
 *  不计入 mainHits（自清面，与文本层/沙箱 profile 层同一形态+谓词单一真相源
 *  debrisRmAllowPath）。检视一轮严重 4 收口：豁免前要求**整命令**通过单目标 rm 形态
 *  （debrisRmAllowPath 锚定整命令）——多目标/链式 rm 残渣不再逐 target 豁免，此前
 *  `rm <残渣A> <残渣B>` 两目标各自被谓词豁免得 verdict ALLOW，与另两层（整命令形态
 *  判定、不豁免）分叉。判定含只读 IO（git ls-files），与 safeRealpath 同类。 */
export function evaluateWriteVerdict(command: string, projectRoot: string, startCwd: string = projectRoot, scriptPayload?: ScriptPayloadInfo, feedReadOnly?: boolean): WriteVerdictResult {
  const r = evaluateWriteTargets(command, projectRoot, startCwd, scriptPayload, feedReadOnly);
  if (r.kind === "unevaluated") return { verdict: "BLOCK", mode: "fail-closed", reason: r.reason };
  // 形态闸：整命令未过单目标 rm 形态+谓词 → 无任何 entryOp 豁免（三层同口径）。
  const debrisExemptPath = debrisRmAllowPath(command, startCwd, projectRoot);
  const mainHits = r.targets.filter(t => {
    if (t.access !== "write") return false;
    if (t.entryOp) return pathEntryWithinMain(t.path, projectRoot) && !(debrisExemptPath !== null && isUntrackedProbeDebris(t.path, projectRoot));
    return pathWithinMain(t.path, projectRoot);
  });
  if (mainHits.length > 0) return { verdict: "BLOCK", mode: "positive", targets: r.targets, mainHits };
  return { verdict: "ALLOW", mode: "positive", targets: r.targets };
}

export type { WriteEvalResult, ScriptPayloadInfo };
