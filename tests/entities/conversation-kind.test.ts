/**
 * #1224：ConversationKind 单源化测试锁。
 *
 * 单源形态（1725-r1 严重 1 处置后）：类型从数组派生
 * （type ConversationKind = (typeof CONVERSATION_KINDS)[number]）——数组与
 * 类型是同一实体，新增枚举值只改数组一处，漏进类型/漏进数组在编译期不可能
 * （原 satisfies 子集锁只锁「数组 ⊆ 类型」方向，防 #1201 的有害方向零拦截，
 * 已实验证伪后改派生形态）。
 *
 * 运行时锁：数组镜像断言（无重复无遗漏）+ 守卫真值表（合法值全过、非法值
 * 全拦）+ narrowing 生效。
 */
import { describe, it, expect } from "vitest";
import {
  CONVERSATION_KINDS,
  isConversationKind,
  type ConversationKind,
} from "../../src/entities/conversation/conversation";

describe("#1224 ConversationKind 单源", () => {
  it("单源锁：数组与派生类型是同一实体（typeof[number]），镜像断言无重复无遗漏", () => {
    // 编译期由 typeof[number] 派生保证（同一实体不可分叉）；运行时镜像锁数组无重复、无遗漏
    expect([...CONVERSATION_KINDS]).toEqual(["normal", "assistant", "web-assistant"]);
    expect(new Set(CONVERSATION_KINDS).size).toBe(CONVERSATION_KINDS.length);
  });

  it("守卫真值表——合法值全过、非法值全拦", () => {
    for (const k of CONVERSATION_KINDS) {
      expect(isConversationKind(k)).toBe(true);
    }
    for (const bad of ["", "Normal", "web", "webassistant", "NORMAL", undefined, null, 1, {}, []]) {
      expect(isConversationKind(bad)).toBe(false);
    }
  });

  it("守卫 narrowing 生效——unknown 经守卫后可赋给 ConversationKind", () => {
    const v: unknown = "web-assistant";
    if (isConversationKind(v)) {
      const k: ConversationKind = v; // 编译通过即 narrowing 生效
      expect(k).toBe("web-assistant");
    } else {
      throw new Error("unreachable: guard should pass");
    }
  });
});
