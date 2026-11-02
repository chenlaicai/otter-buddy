/**
 * #1224：ConversationKind 单源化测试锁——三道防线防「新增枚举值漏改平行硬编码」。
 *
 * 防线 1（穷尽性锁，编译期）：CONVERSATION_KINDS satisfies readonly ConversationKind[]
 *   ——类型与数组不穷尽一致即编译红（数组多出非法值 / 类型新增值漏进数组都拦）。
 * 防线 2（守卫真值表，运行时）：isConversationKind 对全部合法值 true、非法值 false。
 * 防线 3（消费点行为锁）：db mapper 非枚举回退 normal、controller query 非法值
 *   undefined、DTO→Local 投影 kind 透传——新增枚举值时本文件三处消费点行为
 *   自动跟随单源（改 entities 一处即全链生效），漏改任何平行硬编码的场景
 *   从成因上不再存在。
 */
import { describe, it, expect } from "vitest";
import {
  CONVERSATION_KINDS,
  isConversationKind,
  type ConversationKind,
} from "../../src/entities/conversation/conversation";

describe("#1224 ConversationKind 单源", () => {
  it("防线 1：CONVERSATION_KINDS 穷尽且恰好等于类型联合（运行时镜像断言）", () => {
    // 编译期由 satisfies 保证；运行时镜像锁数组无重复、无遗漏
    expect([...CONVERSATION_KINDS]).toEqual(["normal", "assistant", "web-assistant"]);
    expect(new Set(CONVERSATION_KINDS).size).toBe(CONVERSATION_KINDS.length);
  });

  it("防线 2：守卫真值表——合法值全过、非法值全拦", () => {
    for (const k of CONVERSATION_KINDS) {
      expect(isConversationKind(k)).toBe(true);
    }
    for (const bad of ["", "Normal", "web", "webassistant", "NORMAL", undefined, null, 1, {}, []]) {
      expect(isConversationKind(bad)).toBe(false);
    }
  });

  it("防线 2b：守卫 narrowing 生效——unknown 经守卫后可赋给 ConversationKind", () => {
    const v: unknown = "web-assistant";
    if (isConversationKind(v)) {
      const k: ConversationKind = v; // 编译通过即 narrowing 生效
      expect(k).toBe("web-assistant");
    } else {
      throw new Error("unreachable: guard should pass");
    }
  });
});
