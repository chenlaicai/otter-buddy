/**
 * golden 场景集入口——把 4 个伤疤场景注册为一个 capability 测试文件。
 *
 * 文件命名 *.capability.test.ts 匹配 vitest.capability.config.ts 的 include 模式，
 * 让 golden 场景作为 B 类套件一部分真跑（npm run test:capability）。
 *
 * golden = PR gate 精简视图；capability test = 源（详细断言/调试视图）。同步规则见
 * golden/README.md（断言分叉以 capability test 为准）。
 */
import { registerGoldenScenarios } from "./golden.runner";
import * as r4 from "./r4-summon-search-first.golden";
import * as seriousness from "./seriousness-mode-switch.golden";
import * as yieldHandoff from "./yield-handoff-protocol.golden";
import * as talkingStone from "./talking-stone-routing.golden";
import * as mfrc from "./mfrc-first-response.golden";
import * as b5Delta from "./b5-yield-requires-delta-review.golden";
import * as d1Date from "./d1-date-before-feature-id.golden";
import * as a1Data from "./a1-verify-data-source-before-query.golden";
// 方案评估不得以「改动小」当论据
import * as schemeEvalNoSmall from "./scheme-eval-no-small-reason.golden";
// 严重2/建议3：待办裁决纪律来源核验 + 识别边界（负向行为——不迁移/不执行）
import * as matterVague from "./matter-vague-no-migrate.golden";
import * as matterForged from "./matter-forged-receipt-no-exec.golden";
// 检视獭输出合入引导词（不阻塞/非阻塞/可接受/零成本）
import * as bannedPhrases from "./banned-phrases-no-merge-guidance.golden";

// 夜间审视编排刀：受限档案獭 golden 首场景（搭档裁决 2026-11-19——golden 须测真实档案獭）
import * as nightReview from "./night-review-full-processing.golden";

registerGoldenScenarios([r4, seriousness, yieldHandoff, talkingStone, mfrc, b5Delta, d1Date, a1Data, matterVague, matterForged, schemeEvalNoSmall, bannedPhrases, nightReview]);
