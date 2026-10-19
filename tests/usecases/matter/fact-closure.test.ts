/**
 * F20261019fckd（#1457）：事实型闭环分流——closure_kind 守卫矩阵单测。
 *
 * 覆盖（issue #1457 验收标准的三条落进用例）：
 * 1. fact 型 L2 owner 携机器证据直关 ✅（PR 号 / commit sha / mergedAt 三形态）
 * 2. fact 型 L2 缺机器证据被拒 ✅（补偿条件——放权必须有证据）
 * 3. decision 型 L2 owner 直关被拒 ✅（闸不变，不许弱化）
 * 4. 存量 null 保守视同 decision ✅（老数据不放开）
 * 5. partner 关 decision 型 ✅（搭档确认路径不受影响）
 * 6. L1 不受影响 ✅（L1 本来就獭自关）
 * 7. 迁移时补标 fact + 携证据一步直关 ✅（审计留痕）
 * 8. closure_kind 持久化 roundtrip（register 登记 → repo 读回）
 * 9. hasMachineEvidence 三形态判定
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteMatterRepository } from '@frameworks/db/matter/sqlite-matter-repository';
import { RegisterMatter } from '@usecases/matter/register-matter';
import { TransitionMatter, hasMachineEvidence } from '@usecases/matter/transition-matter';
import type { Matter } from '@entities/matter/matter';
import { DomainError } from '@entities/errors';

const OWNER = 'otter-owner-1';
const OTHER_OTTER = 'otter-other-2';

function makeMatter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: '1234abcd-2222-3333-4444-555555555555',
    conversationId: 'conv-1',
    title: '事实型闭环事项',
    originMessageId: null,
    ownerOtterId: OWNER,
    level: 'L2',
    closureKind: null,
    state: 'DONE_PENDING_CONFIRM',
    waitingOn: 'partner',
    waitingFor: '闭环确认',
    payload: null,
    resolution: null,
    resolvedBy: null,
    createdAt: '2026-10-19T10:00:00.000Z',
    updatedAt: '2026-10-19T10:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

describe('fact 型闭环分流（F20261019fckd，#1457）', () => {
  let db: Database.Database;
  let repo: SqliteMatterRepository;
  let transition: TransitionMatter;
  let register: RegisterMatter;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteMatterRepository(db);
    transition = new TransitionMatter(repo);
    register = new RegisterMatter(repo);
  });

  it('fact 型 L2 owner 携机器证据（PR 号）直关放行 + resolvedBy 留痕', async () => {
    await repo.create(makeMatter({ closureKind: 'fact' }));
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER,
      resolution: 'PR #1535 已合入 main——机器事实闭环',
    });
    expect(updated.state).toBe('CLOSED');
    expect(updated.closedAt).not.toBeNull();
    expect(updated.resolvedBy).toBe(`otter:${OWNER}`);
  });

  it('fact 型 L2 owner 携 commit sha 证据直关放行', async () => {
    await repo.create(makeMatter({ closureKind: 'fact' }));
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER,
      resolution: 'mergeCommit a1b2c3d4e5f60718293a4b5c 已进 main',
    });
    expect(updated.state).toBe('CLOSED');
  });

  it('fact 型 L2 owner 携 mergedAt + PR 号复合证据直关放行（关键词单独不构成证据——收紧后须与锚点同现）', async () => {
    await repo.create(makeMatter({ closureKind: 'fact' }));
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER,
      resolution: 'GitHub API mergedAt=2026-10-19T02:00:00Z（PR #1535）——非 null 即已合入',
    });
    expect(updated.state).toBe('CLOSED');
  });

  it('fact 型 L2 缺机器证据被拒（resolution 只有自述，无锚点）', async () => {
    await repo.create(makeMatter({ closureKind: 'fact' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER,
      resolution: '做完了，我确认没问题',
    })).rejects.toThrow(/机器证据/);
  });

  it('fact 型 L2 resolution 为空被拒（工具层必填校验之外的双保险）', async () => {
    await repo.create(makeMatter({ closureKind: 'fact' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER, resolution: null,
    })).rejects.toThrow(DomainError);
  });

  it('fact 型 L2 纯 mergedAt 关键词无锚点被拒（零锚点散文不可直关——检视建议 1 收紧）', async () => {
    await repo.create(makeMatter({ closureKind: 'fact' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER,
      resolution: 'GitHub API mergedAt 字段非空，我确认已合入',
    })).rejects.toThrow(/机器证据/);
  });

  it('fact 型 L2 纯 mergeCommit 关键词无锚点被拒（同上——关键词不单独成立）', async () => {
    await repo.create(makeMatter({ closureKind: 'fact' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER,
      resolution: '查了 mergeCommit 字段存在，见上文',
    })).rejects.toThrow(/机器证据/);
  });

  it('decision 型 L2 owner 直关被拒——闸不变（防矫枉过正）', async () => {
    await repo.create(makeMatter({ closureKind: 'decision' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER,
      resolution: 'PR #1535 已合入，效果我认为达标',
    })).rejects.toThrow(/宣告权拒绝/);
  });

  it('decision 型 L2 即使带机器证据 owner 直关仍被拒——证据不豁免判断型', async () => {
    await repo.create(makeMatter({ closureKind: 'decision' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER,
      resolution: 'PR #1535 已合入 + mergedAt 确认——但这是验收型闭环',
    })).rejects.toThrow(/宣告权拒绝/);
  });

  it('存量 null 保守视同 decision：owner 直关被拒（老数据不放开）', async () => {
    await repo.create(makeMatter({ closureKind: null }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER,
      resolution: 'PR #1535 已合入',
    })).rejects.toThrow(/宣告权拒绝/);
  });

  it('partner 关 decision 型放行（搭档确认路径不受分流影响）', async () => {
    await repo.create(makeMatter({ closureKind: 'decision' }));
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: 'partner', resolution: '确认闭环',
    });
    expect(updated.state).toBe('CLOSED');
    expect(updated.resolvedBy).toBe('partner');
  });

  it('partner 关 fact 型放行（搭档永远有权确认，无需证据形态约束）', async () => {
    await repo.create(makeMatter({ closureKind: 'fact' }));
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: 'partner', resolution: '我看过了，确认',
    });
    expect(updated.state).toBe('CLOSED');
  });

  it('L1 不受影响：closureKind 任意取值 owner 均自关放行', async () => {
    await repo.create(makeMatter({ level: 'L1', closureKind: null }));
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER, resolution: 'L1 自关',
    });
    expect(updated.state).toBe('CLOSED');

    await repo.create(makeMatter({ id: '5678efab-2222-3333-4444-555555555555', level: 'L1', closureKind: 'decision' }));
    const updated2 = await transition.execute({
      matterId: '5678efab-2222-3333-4444-555555555555', to: 'CLOSED', actor: OWNER, resolution: 'L1 自关2',
    });
    expect(updated2.state).toBe('CLOSED');
  });

  it('迁移时补标 fact + 携证据一步直关（存量 null 件补标放行 + closure_kind 列留痕）', async () => {
    await repo.create(makeMatter({ closureKind: null }));
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER,
      closureKind: 'fact',
      resolution: 'issue #1457 对应 PR #1535 已 MERGED（mergedAt 2026-10-19）',
    });
    expect(updated.state).toBe('CLOSED');
    expect(updated.closureKind).toBe('fact'); // 补标持久化
    // 读回验证列已落库
    const reread = await repo.findById(makeMatter().id);
    expect(reread?.closureKind).toBe('fact');
  });

  it('迁移时补标 fact 但缺证据仍拒（补标不豁免证据）', async () => {
    await repo.create(makeMatter({ closureKind: null }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER,
      closureKind: 'fact',
      resolution: '做完了',
    })).rejects.toThrow(/机器证据/);
  });

  it('非 owner 獭对 fact 型直关被拒（矩阵触发者守卫仍兜底——allowed=owner/partner）', async () => {
    await repo.create(makeMatter({ closureKind: 'fact' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OTHER_OTTER,
      resolution: 'PR #1535 已合入',
    })).rejects.toThrow(/非法迁移触发者/);
  });

  it('补标 kind 不改变 L2 decision 闸：补标 decision 的 fact 存量件直关被拒', async () => {
    await repo.create(makeMatter({ closureKind: 'fact' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER,
      closureKind: 'decision',
      resolution: 'PR #1535 已合入',
    })).rejects.toThrow(/宣告权拒绝/);
  });

  it('closure_kind 非终态迁移也持久化补标（不迁移到 CLOSED 只标 kind）', async () => {
    const m = await register.execute({
      conversationId: 'conv-1', title: '验收客观化', initialState: 'OPEN',
      ownerOtterId: OWNER, level: 'L2',
    });
    await transition.execute({ matterId: m.id, to: 'WAITING_OTTER', actor: OWNER });
    const updated = await transition.execute({
      matterId: m.id, to: 'DONE_PENDING_CONFIRM', actor: OWNER,
      resolution: '已交付', closureKind: 'fact',
    });
    expect(updated.state).toBe('DONE_PENDING_CONFIRM');
    expect(updated.closureKind).toBe('fact');
  });

  it('register 登记 fact → repo roundtrip 持久化', async () => {
    const created = await register.execute({
      conversationId: 'conv-1', title: 'PR 合入关单', initialState: 'OPEN',
      ownerOtterId: OWNER, level: 'L2', closureKind: 'fact',
    });
    expect(created.closureKind).toBe('fact');
    const found = await repo.findById(created.id);
    expect(found?.closureKind).toBe('fact');
  });

  it('register 登记 decision / 缺省 null → 视同判断型', async () => {
    const d = await register.execute({
      conversationId: 'conv-1', title: '方案验收', initialState: 'OPEN',
      ownerOtterId: OWNER, level: 'L2', closureKind: 'decision',
    });
    expect(d.closureKind).toBe('decision');
    const n = await register.execute({
      conversationId: 'conv-1', title: '未标注口径', initialState: 'OPEN',
      ownerOtterId: OWNER, level: 'L2',
    });
    expect(n.closureKind).toBeNull();
  });

  it('hasMachineEvidence：三形态认可 / 自述无锚点不认', () => {
    expect(hasMachineEvidence('PR #1535 已合入')).toBe(true);
    expect(hasMachineEvidence('issue #42 关闭')).toBe(true);
    expect(hasMachineEvidence('sha a1b2c3d4e5f60718293a4b5c6d7e8f9')).toBe(true);
    expect(hasMachineEvidence('短 sha 40 位上限 0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(hasMachineEvidence('超限 41 位不单独认可：0123456789abcdef0123456789abcdef012345678')).toBe(false); // 41 位 hex 超界（且无其他锚）
    expect(hasMachineEvidence('mergedAt=2026-10-19T02:00:00Z')).toBe(false); // 关键词单独不构成证据（收紧后须与 #号/sha 同现）
    expect(hasMachineEvidence('mergedAt + PR #1535 均确认')).toBe(true);       // 关键词与锚点同现：锤①独立成立
    expect(hasMachineEvidence('mergeCommit 前缀 abc1234')).toBe(true);        // sha 规则②独立成立（abc1234 为 7 位 hex）
    expect(hasMachineEvidence('做完了，我确认没问题')).toBe(false);
    expect(hasMachineEvidence('')).toBe(false);
    expect(hasMachineEvidence('#1')).toBe(false);          // 1 位太短（#1 形近 matter 短锚，不算 PR 号）
    expect(hasMachineEvidence('#1234567')).toBe(true);     // #后 7 位超 PR 号界，但 7 位纯数字本身是合法短 sha 形态（宽松方向重叠，可接受）
    expect(hasMachineEvidence('#1234567890123')).toBe(true);  // 13 位纯数字：超 PR 号界但仍是合法 hex sha 形态（宽松方向重叠，可接受）
    expect(hasMachineEvidence('#12345678901z')).toBe(false); // 含非 hex 字符 z 且超 PR 号界——两形态都不命中
    expect(hasMachineEvidence('abc')).toBe(false);         // hex 不足 7 位
  });
});
