/**
 * TransitionMatter——状态迁移单入口（F20261005mtlp §2）。
 *
 * 单一真相源纪律的物理落点：所有状态迁移（獭侧 transition_matter 工具、
 * 板上按钮 P2、扫描器兜底重派）必须走本 usecase，非法迁移在此拒绝。
 *
 * 守卫分层（各守卫独立方法，execute 只做编排）：
 * 1. 矩阵守卫：from×to 必须在 §2 合法迁移矩阵内（未列入 = 一律非法）
 * 2. 触发者守卫：矩阵条目的 allowed 集合（owner/partner/any_otter/system）
 * 3. 宣告权守卫（L2 闭环分权）：DONE_PENDING_CONFIRM → CLOSED 时
 *    level=L2 必须搭档确认（actorType='partner'）；L1 獭可自关留痕（搭档可翻案重开）
 * 4. 幂等：已是目标态短路返回；repo.transition 条件更新（WHERE state = ?）——
 *    并发迁移只有一方成功，另一方读到 changes=0 走幂等/冲突语义
 */

import { DomainError } from '@entities/errors';
import type { Matter, MatterState } from '@entities/matter/matter';
import { findMatterTransition, type MatterTransition } from '@entities/matter/matter-transitions';
import type { MatterRepository } from './matter-repository';

export interface TransitionMatterInput {
  /** matter ID（短锚 M-xxx 由工具层解析成完整 ID 后传入） */
  matterId: string;
  to: MatterState;
  /** 触发者：'partner' | otterId（system 仅创建路径，本入口不接受） */
  actor: string;
  resolution?: string | null;
  waitingOn?: string | null;
  waitingFor?: string | null;
  payload?: string | null;
}

/** 触发者分类（守卫 2/3 的输入） */
function classifyActor(actor: string, ownerOtterId: string | null): 'partner' | 'owner' | 'any_otter' {
  if (actor === 'partner') return 'partner';
  if (ownerOtterId && actor === ownerOtterId) return 'owner';
  return 'any_otter';
}

/** 触发者是否有权触发该迁移（any_otter = 任意獭，含 owner——通道 A 代执行路径） */
function actorAllowed(transition: MatterTransition, actorType: 'partner' | 'owner' | 'any_otter', actor: string): boolean {
  if (transition.allowed.includes(actorType)) return true;
  return transition.allowed.includes('any_otter') && actor !== 'partner';
}

/** 宣告权守卫：L2 matter 的闭环必须搭档确认（§2 闭环宣告权表） */
function assertCloseAuthority(matter: Matter, to: MatterState, actorType: string): void {
  if (matter.state === 'DONE_PENDING_CONFIRM' && to === 'CLOSED' && matter.level === 'L2'
    && actorType !== 'partner') {
    throw new DomainError(
      '宣告权拒绝：L2 matter 的闭环必须搭档确认（DONE_PENDING_CONFIRM → CLOSED 仅 partner 可触发）',
      'validation',
    );
  }
}

/**
 * 目标态的默认 waitingOn（迁移语义的一部分：呈拍板等搭档/回 OPEN 清空）。
 * requested 语义：undefined = 未指定（按目标态默认）；null = 显式清空；字符串 = 指定。
 */
function defaultWaitingOn(matter: Matter, to: MatterState, requested: string | null | undefined): string | null {
  if (requested !== undefined) return requested;
  if (to === 'WAITING_PARTNER') return 'partner';
  if (to === 'OPEN') return null;
  return matter.waitingOn;
}

/** 守卫编排：矩阵 + 触发者 + 宣告权（execute 只做编排） */
function assertTransitionAllowed(matter: Matter, to: MatterState, actor: string): void {
  const transition = findMatterTransition(matter.state, to);
  if (!transition) {
    throw new DomainError(
      `非法迁移：${matter.state} → ${to} 不在合法迁移矩阵内（F20261005mtlp §2）`,
      'validation',
    );
  }
  const actorType = classifyActor(actor, matter.ownerOtterId);
  if (!actorAllowed(transition, actorType, actor)) {
    throw new DomainError(
      `非法迁移触发者：${matter.state} → ${to} 只能由 ${transition.allowed.join('/')} 触发，` +
      `当前触发者 ${actor}（${actorType}）无权`,
      'validation',
    );
  }
  assertCloseAuthority(matter, to, actorType);
}

export class TransitionMatter {
  constructor(private readonly repo: MatterRepository) {}

  async execute(input: TransitionMatterInput): Promise<Matter> {
    const matter = await this.repo.findById(input.matterId);
    if (!matter) {
      throw new DomainError(`matter ${input.matterId} 不存在`, 'not_found');
    }

    // 幂等短路：已是目标态直接返回（同目标重复迁移/并发重试不产生副作用）
    if (matter.state === input.to) {
      return matter;
    }

    // ---- 守卫 1+2+3：矩阵 + 触发者 + 宣告权 ----
    assertTransitionAllowed(matter, input.to, input.actor);

    const now = new Date().toISOString();
    const isTerminal = input.to === 'CLOSED' || input.to === 'SUPERSEDED' || input.to === 'ABANDONED';
    const updated = await this.repo.transition(matter.id, matter.state, {
      state: input.to,
      waitingOn: defaultWaitingOn(matter, input.to, input.waitingOn),
      waitingFor: input.waitingFor ?? matter.waitingFor,
      payload: input.payload ?? matter.payload,
      resolution: input.resolution ?? matter.resolution,
      resolvedBy: isTerminal ? input.actor : matter.resolvedBy,
      updatedAt: now,
      ...(isTerminal ? { closedAt: now } : {}),
    });
    if (!updated) {
      return this.resolveConcurrentOutcome(matter, input.to, isTerminal);
    }
    return updated;
  }

  /**
   * 并发迁移已被另一方抢先（条件更新 changes=0）——读回当前态给调用方：
   * 已到目标态/已闭环 → 幂等返回；否则报冲突让调用方重试。
   */
  private async resolveConcurrentOutcome(matter: Matter, to: MatterState, isTerminal: boolean): Promise<Matter> {
    const current = await this.repo.findById(matter.id);
    if (current && (current.state === to || (current.state === 'CLOSED' && isTerminal))) {
      return current;
    }
    throw new DomainError(
      `matter ${matter.id} 状态已被并发迁移（期望 ${matter.state}，实际 ${current?.state ?? '不存在'}），请重试`,
      'conflict',
    );
  }
}
