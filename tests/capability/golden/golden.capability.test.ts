/**
 * F20260825evgl: golden 场景集入口——把 4 个伤疤场景注册为一个 capability 测试文件。
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
import * as skillReferences from "./skill-references-visibility.golden";

registerGoldenScenarios([r4, seriousness, yieldHandoff, talkingStone, skillReferences]);
