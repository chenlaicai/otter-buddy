/**
 * F20261005mtlp P1：matter 状态机迁移矩阵单测（方案 §2——验证节锁定项）。
 *
 * 覆盖：
 * 1. 合法迁移全矩阵（§2 表 14 条存续迁移逐条放行）
 * 2. 非法迁移拒绝（未列入矩阵的组合一律拒绝——含终态互迁、反向迁移）
 * 3. 触发者守卫（partner 专属迁移獭不能代执行）
 * 4. 宣告权分权（L2 无搭档确认不可 CLOSED；L1 獭可自关留痕）
 * 5. 幂等（并发迁移条件更新语义）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteMatterRepository } from '@frameworks/db/matter/sqlite-matter-repository';
import { RegisterMatter } from '@usecases/matter/register-matter';
import { TransitionMatter } from '@usecases/matter/transition-matter';
import type { Matter, MatterLevel, MatterState } from '@entities/matter/matter';
import { DomainError } from '@entities/errors';

const OWNER = 'otter-owner-1';
const OTHER_OTTER = 'otter-other-2';

function makeMatter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    conversationId: 'conv-1',
    title: '测试事项',
    originMessageId: null,
    ownerOtterId: OWNER,
    level: 'L1',
    state: 'OPEN',
    waitingOn: null,
    waitingFor: null,
    payload: null,
    resolution: null,
    resolvedBy: null,
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

describe('matter 状态机：合法迁移矩阵（§2 全量）', () => {
  let db: Database.Database;
  let repo: SqliteMatterRepository;
  let transition: TransitionMatter;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteMatterRepository(db);
    transition = new TransitionMatter(repo);
  });

  async function seedMatter(state: MatterState, level: MatterLevel = 'L1'): Promise<Matter> {
    const matter = makeMatter({ state, level });
    await repo.create(matter);
    return matter;
  }

  it('OPEN → WAITING_OTTER（獭认领，waiting_on 默认=认领獭——§2 矩阵 note）', async () => {
    await seedMatter('OPEN');
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'WAITING_OTTER', actor: OTHER_OTTER,
      waitingFor: '续办',
    });
    expect(updated.state).toBe('WAITING_OTTER');
    expect(updated.waitingOn).toBe(`otter:${OTHER_OTTER}`);
  });

  it('OPEN → WAITING_PARTNER（獭呈拍板）', async () => {
    await seedMatter('OPEN');
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'WAITING_PARTNER', actor: OTHER_OTTER, payload: '{"brief":"选A还是B"}',
    });
    expect(updated.state).toBe('WAITING_PARTNER');
    expect(updated.waitingOn).toBe('partner');
  });

  it('WAITING_OTTER → WAITING_PARTNER（owner 干完需裁决）', async () => {
    await seedMatter('WAITING_OTTER');
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'WAITING_PARTNER', actor: OWNER,
    });
    expect(updated.state).toBe('WAITING_PARTNER');
  });

  it('WAITING_OTTER → DONE_PENDING_CONFIRM（owner 宣称完成）', async () => {
    await seedMatter('WAITING_OTTER');
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'DONE_PENDING_CONFIRM', actor: OWNER, resolution: '已完成 X',
    });
    expect(updated.state).toBe('DONE_PENDING_CONFIRM');
  });

  it('WAITING_PARTNER → DONE_PENDING_CONFIRM（搭档批准）', async () => {
    await seedMatter('WAITING_PARTNER');
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'DONE_PENDING_CONFIRM', actor: 'partner', resolution: '批准按方案A',
    });
    expect(updated.state).toBe('DONE_PENDING_CONFIRM');
  });

  it('WAITING_PARTNER → WAITING_OTTER（搭档打回）', async () => {
    await seedMatter('WAITING_PARTNER');
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'WAITING_OTTER', actor: 'partner',
      waitingOn: `otter:${OWNER}`, waitingFor: '按反馈再改',
    });
    expect(updated.state).toBe('WAITING_OTTER');
  });

  it('DONE_PENDING_CONFIRM → CLOSED（L1 獭自关留痕）', async () => {
    await seedMatter('DONE_PENDING_CONFIRM', 'L1');
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER, resolution: 'L1 自关',
    });
    expect(updated.state).toBe('CLOSED');
    expect(updated.closedAt).not.toBeNull();
    expect(updated.resolvedBy).toBe(`otter:${OWNER}`); // §1 口径：otter:<id>
  });

  it('DONE_PENDING_CONFIRM → CLOSED（L2 搭档确认）', async () => {
    await seedMatter('DONE_PENDING_CONFIRM', 'L2');
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: 'partner', resolution: '确认闭环',
    });
    expect(updated.state).toBe('CLOSED');
    expect(updated.resolvedBy).toBe('partner');
  });

  it('DONE_PENDING_CONFIRM → WAITING_OTTER（搭档打回闭环，显式 waitingOn 生效）', async () => {
    await seedMatter('DONE_PENDING_CONFIRM');
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'WAITING_OTTER', actor: 'partner', waitingOn: `otter:${OWNER}`,
    });
    expect(updated.state).toBe('WAITING_OTTER');
    expect(updated.waitingOn).toBe(`otter:${OWNER}`);
  });

  it('N3：打回路径不指定 waitingOn 时默认 = owner（消灭 stale partner 漏扫）', async () => {
    await seedMatter('WAITING_PARTNER');
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'WAITING_OTTER', actor: 'partner',
      resolution: '打回再改',
    });
    expect(updated.state).toBe('WAITING_OTTER');
    expect(updated.waitingOn).toBe(`otter:${OWNER}`); // 默认等 owner 续办，不残留 partner
  });

  it('CLOSED → OPEN（搭档翻案重开）', async () => {
    await seedMatter('CLOSED');
    // 直接落 CLOSED 态（终态）→ 翻案
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'OPEN', actor: 'partner',
    });
    expect(updated.state).toBe('OPEN');
    expect(updated.closedAt).toBeNull();
  });

  it.each([
    ['OPEN', OTHER_OTTER],
    ['WAITING_OTTER', OWNER],
    ['WAITING_PARTNER', OWNER],
    ['DONE_PENDING_CONFIRM', OWNER],
  ] as Array<[MatterState, string]>)('%s → SUPERSEDED（獭取代，actor=%s）', async (from, actor) => {
    await seedMatter(from);
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'SUPERSEDED', actor, resolution: '被 M-new 取代',
    });
    expect(updated.state).toBe('SUPERSEDED');
  });

  it.each([
    ['OPEN'],
    ['WAITING_OTTER'],
    ['WAITING_PARTNER'],
    ['DONE_PENDING_CONFIRM'],
  ] as Array<[MatterState]>)('%s → ABANDONED（搭档明确不做）', async (from) => {
    await seedMatter(from);
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'ABANDONED', actor: 'partner', resolution: '不做了',
    });
    expect(updated.state).toBe('ABANDONED');
  });
});

describe('matter 状态机：非法迁移拒绝', () => {
  let db: Database.Database;
  let repo: SqliteMatterRepository;
  let transition: TransitionMatter;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteMatterRepository(db);
    transition = new TransitionMatter(repo);
  });

  async function seedAndExpectIllegal(from: MatterState, to: MatterState, actor: string): Promise<void> {
    await repo.create(makeMatter({ state: from }));
    await expect(transition.execute({ matterId: makeMatter().id, to, actor }))
      .rejects.toThrow(DomainError);
    await expect(transition.execute({ matterId: makeMatter().id, to, actor }))
      .rejects.toThrow(/非法迁移/);
  }

  it.each([
    ['CLOSED', 'WAITING_PARTNER'],   // 终态不出（翻案只能 →OPEN）
    ['CLOSED', 'WAITING_OTTER'],
    ['CLOSED', 'DONE_PENDING_CONFIRM'],
    ['SUPERSEDED', 'OPEN'],          // 终态不可逆
    ['ABANDONED', 'OPEN'],
    ['OPEN', 'CLOSED'],              // 无 DONE_PENDING_CONFIRM 直达闭环
    ['OPEN', 'DONE_PENDING_CONFIRM'],
    ['WAITING_PARTNER', 'OPEN'],     // 无此迁移（打回走 WAITING_OTTER）
    ['WAITING_OTTER', 'OPEN'],       // 无反向迁移
    ['WAITING_OTTER', 'CLOSED'],     // 跳过 DONE_PENDING_CONFIRM
    ['WAITING_PARTNER', 'CLOSED'],   // 跳过 DONE_PENDING_CONFIRM
    ['DONE_PENDING_CONFIRM', 'WAITING_PARTNER'], // 无反向迁移
  ] as Array<[MatterState, MatterState]>)('%s → %s 非法拒绝', async (from, to) => {
    await seedAndExpectIllegal(from, to, 'partner');
  });

  it('不存在的 matter 报 not_found', async () => {
    await expect(transition.execute({
      matterId: '99999999-9999-9999-9999-999999999999', to: 'CLOSED', actor: 'partner',
    })).rejects.toThrow(/不存在/);
  });
});

describe('matter 状态机：触发者守卫', () => {
  let db: Database.Database;
  let repo: SqliteMatterRepository;
  let transition: TransitionMatter;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteMatterRepository(db);
    transition = new TransitionMatter(repo);
  });

  it('partner 专属迁移：WAITING_PARTNER→DONE_PENDING_CONFIRM 无代执行声明拒绝（§3.5 声明后放行见下组）', async () => {
    await repo.create(makeMatter({ state: 'WAITING_PARTNER' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'DONE_PENDING_CONFIRM', actor: OWNER,
    })).rejects.toThrow(/非法迁移触发者/);
  });

  it('partner 专属迁移：ABANDONED 只能搭档宣告', async () => {
    await repo.create(makeMatter({ state: 'OPEN' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'ABANDONED', actor: OWNER, resolution: 'x',
    })).rejects.toThrow(/非法迁移触发者/);
  });

  it('翻案（CLOSED→OPEN）只能搭档', async () => {
    await repo.create(makeMatter({ state: 'CLOSED' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'OPEN', actor: OWNER,
    })).rejects.toThrow(/非法迁移触发者/);
  });

  it('owner 专属迁移：WAITING_OTTER→WAITING_PARTNER 非 owner 无声明拒绝（§3.5 声明后放行见下组）', async () => {
    await repo.create(makeMatter({ state: 'WAITING_OTTER' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'WAITING_PARTNER', actor: OTHER_OTTER,
    })).rejects.toThrow(/非法迁移触发者/);
  });
});

describe('matter 状态机：代执行（§3.5 通道 A——声明后按被代理者身份过守卫）', () => {
  let db: Database.Database;
  let repo: SqliteMatterRepository;
  let transition: TransitionMatter;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteMatterRepository(db);
    transition = new TransitionMatter(repo);
  });

  it('獭代搭档执行裁决：WAITING_PARTNER→DONE_PENDING_CONFIRM（on_behalf_of=partner 放行 + 留痕）', async () => {
    await repo.create(makeMatter({ state: 'WAITING_PARTNER', level: 'L2' }));
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'DONE_PENDING_CONFIRM',
      actor: OTHER_OTTER, onBehalfOf: 'partner', resolution: '代搭档执行：批准按方案A',
    });
    expect(updated.state).toBe('DONE_PENDING_CONFIRM');
    expect(updated.resolution).toBe('代搭档执行：批准按方案A');
    // N1 修订：resolvedBy 统一记实际执行獭（被代理者身份经 resolution 留痕）
    expect(updated.resolvedBy).toBe(`otter:${OTHER_OTTER}`);
  });

  it('獭代搭档宣告闭环：L2 DONE_PENDING_CONFIRM→CLOSED（on_behalf_of=partner 过宣告权守卫）', async () => {
    await repo.create(makeMatter({ state: 'DONE_PENDING_CONFIRM', level: 'L2' }));
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'CLOSED',
      actor: OTHER_OTTER, onBehalfOf: 'partner', resolution: '代搭档执行：确认闭环',
    });
    expect(updated.state).toBe('CLOSED');
    expect(updated.resolvedBy).toBe(`otter:${OTHER_OTTER}`); // 终态记实际执行獭
  });

  it('獭代 owner 执行：WAITING_OTTER→DONE_PENDING_CONFIRM（on_behalf_of=<ownerId> 放行）', async () => {
    await repo.create(makeMatter({ state: 'WAITING_OTTER' }));
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'DONE_PENDING_CONFIRM',
      actor: OTHER_OTTER, onBehalfOf: OWNER, resolution: '代执行：已完成 X',
    });
    expect(updated.state).toBe('DONE_PENDING_CONFIRM');
    expect(updated.resolvedBy).toBe(`otter:${OTHER_OTTER}`); // N1 修订：记实际执行獭
  });

  it('代执行声明不能越矩阵：獭代搭档执行 WAITING_OTTER→WAITING_PARTNER（owner 专属行）仍拒', async () => {
    await repo.create(makeMatter({ state: 'WAITING_OTTER' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'WAITING_PARTNER',
      actor: OTHER_OTTER, onBehalfOf: 'partner',
    })).rejects.toThrow(/非法迁移触发者/);
  });

  it('代执行声明不能越宣告权：L2 闭环 on_behalf_of=<非 partner> 仍拒', async () => {
    await repo.create(makeMatter({ state: 'DONE_PENDING_CONFIRM', level: 'L2' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'CLOSED',
      actor: OTHER_OTTER, onBehalfOf: OWNER, resolution: '代执行：自认完成',
    })).rejects.toThrow(/宣告权拒绝/);
  });
});

describe('matter 状态机：宣告权分权（L2 闭环必须搭档确认）', () => {
  let db: Database.Database;
  let repo: SqliteMatterRepository;
  let transition: TransitionMatter;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteMatterRepository(db);
    transition = new TransitionMatter(repo);
  });

  it('L2 DONE_PENDING_CONFIRM → CLOSED 獭自关被拒绝（宣告权）', async () => {
    await repo.create(makeMatter({ state: 'DONE_PENDING_CONFIRM', level: 'L2' }));
    await expect(transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER, resolution: '自认完成',
    })).rejects.toThrow(/宣告权拒绝/);
  });

  it('L1 DONE_PENDING_CONFIRM → CLOSED 獭自关放行（留痕可翻案）', async () => {
    await repo.create(makeMatter({ state: 'DONE_PENDING_CONFIRM', level: 'L1' }));
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: OWNER, resolution: 'L1 自关留痕',
    });
    expect(updated.state).toBe('CLOSED');
    expect(updated.resolvedBy).toBe(`otter:${OWNER}`); // §1 口径：otter:<id>
  });

  it('L2 DONE_PENDING_CONFIRM → CLOSED 搭档确认放行', async () => {
    await repo.create(makeMatter({ state: 'DONE_PENDING_CONFIRM', level: 'L2' }));
    const updated = await transition.execute({
      matterId: makeMatter().id, to: 'CLOSED', actor: 'partner', resolution: '确认闭环',
    });
    expect(updated.state).toBe('CLOSED');
    expect(updated.resolvedBy).toBe('partner');
  });
});

describe('matter 状态机：幂等（并发迁移条件更新）', () => {
  it('同一迁移二次执行返回当前态不报错（并发抢先语义）', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const repo = new SqliteMatterRepository(db);
    const transition = new TransitionMatter(repo);
    await repo.create(makeMatter({ state: 'WAITING_PARTNER', level: 'L2' }));

    const first = await transition.execute({
      matterId: makeMatter().id, to: 'DONE_PENDING_CONFIRM', actor: 'partner', resolution: '批准',
    });
    expect(first.state).toBe('DONE_PENDING_CONFIRM');

    // 模拟并发：另一方持有的还是旧 from 态（WAITING_PARTNER）——条件更新落空，
    // 读回当前态已是目标态 → 幂等返回，不报「不存在」
    const second = await transition.execute({
      matterId: makeMatter().id, to: 'DONE_PENDING_CONFIRM', actor: 'partner', resolution: '批准',
    });
    expect(second.state).toBe('DONE_PENDING_CONFIRM');
    expect(second.id).toBe(first.id);
  });
});

describe('RegisterMatter 准入校验', () => {
  it('initialState 只允许 WAITING_PARTNER（路径1）或 OPEN（路径2/3）', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const repo = new SqliteMatterRepository(db);
    const register = new RegisterMatter(repo);

    await expect(register.execute({
      conversationId: 'conv-1', title: 'x', initialState: 'CLOSED' as never,
    })).rejects.toThrow(/initialState/);

    const m1 = await register.execute({
      conversationId: 'conv-1', title: 'L2 拍板项', initialState: 'WAITING_PARTNER',
      ownerOtterId: OWNER, level: 'L2',
    });
    expect(m1.state).toBe('WAITING_PARTNER');
    expect(m1.waitingOn).toBe('partner');

    const m2 = await register.execute({
      conversationId: 'conv-1', title: '回头再说事项', initialState: 'OPEN',
    });
    expect(m2.state).toBe('OPEN');
    expect(m2.waitingOn).toBeNull();
  });

  it('title 必填', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const repo = new SqliteMatterRepository(db);
    const register = new RegisterMatter(repo);
    await expect(register.execute({
      conversationId: 'conv-1', title: '  ', initialState: 'OPEN',
    })).rejects.toThrow(/title/);
  });
});

describe('等待方消亡规则（§2 等待方生命周期规则①——判定键 = waiting_on 指向的獭，补 owner 双扫）', () => {
  it('獭解散 → 名下 WAITING_OTTER 事项转回 OPEN；其他态不受影响', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const repo = new SqliteMatterRepository(db);
    const now = '2026-10-05T12:00:00.000Z';

    await repo.create(makeMatter({ id: 'aaaaaaaa-0000-0000-0000-000000000001', state: 'WAITING_OTTER', ownerOtterId: OWNER, waitingOn: `otter:${OWNER}` }));
    await repo.create(makeMatter({ id: 'aaaaaaaa-0000-0000-0000-000000000002', state: 'WAITING_PARTNER', ownerOtterId: OWNER }));
    await repo.create(makeMatter({ id: 'aaaaaaaa-0000-0000-0000-000000000003', state: 'WAITING_OTTER', ownerOtterId: OTHER_OTTER, waitingOn: `otter:${OTHER_OTTER}` }));

    const changed = await repo.reopenForDissolvedOwner(OWNER, now);
    expect(changed).toBe(1);

    const after = {
      one: await repo.findById('aaaaaaaa-0000-0000-0000-000000000001'),
      two: await repo.findById('aaaaaaaa-0000-0000-0000-000000000002'),
      three: await repo.findById('aaaaaaaa-0000-0000-0000-000000000003'),
    };
    expect(after.one!.state).toBe('OPEN');
    expect(after.one!.waitingOn).toBeNull();
    expect(after.one!.updatedAt).toBe(now);
    expect(after.two!.state).toBe('WAITING_PARTNER'); // 等搭档的不受影响
    expect(after.three!.state).toBe('WAITING_OTTER'); // 别人等待方的不受影响
  });

  it('非 owner 等待方消亡（owner≠waiting_on）也回 OPEN——审视 S2：消灭悬挂优先', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const repo = new SqliteMatterRepository(db);
    const now = '2026-10-05T12:00:00.000Z';

    // owner=A，等待方=B（代执行/打回路径产生）；B 解散 → 回 OPEN
    await repo.create(makeMatter({
      id: 'bbbbbbbb-0000-0000-0000-000000000001', state: 'WAITING_OTTER',
      ownerOtterId: OWNER, waitingOn: `otter:${OTHER_OTTER}`,
    }));

    const changed = await repo.reopenForDissolvedOwner(OTHER_OTTER, now);
    expect(changed).toBe(1);
    const after = await repo.findById('bbbbbbbb-0000-0000-0000-000000000001');
    expect(after!.state).toBe('OPEN');
    expect(after!.waitingOn).toBeNull();
  });

  it('owner 消亡但 waiting_on 指向健在的他獭：不误重开（等待方还在干活）', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const repo = new SqliteMatterRepository(db);
    const now = '2026-10-05T12:00:00.000Z';

    await repo.create(makeMatter({
      id: 'cccccccc-0000-0000-0000-000000000001', state: 'WAITING_OTTER',
      ownerOtterId: OWNER, waitingOn: `otter:${OTHER_OTTER}`,
    }));

    const changed = await repo.reopenForDissolvedOwner(OWNER, now);
    expect(changed).toBe(0);
    const after = await repo.findById('cccccccc-0000-0000-0000-000000000001');
    expect(after!.state).toBe('WAITING_OTTER'); // owner 不在但等待方 B 健在——不误重开
  });

  it('waiting_on 为 NULL（owner 键兜底）的 WAITING_OTTER：owner 解散回 OPEN', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const repo = new SqliteMatterRepository(db);
    const now = '2026-10-05T12:00:00.000Z';

    await repo.create(makeMatter({
      id: 'dddddddd-0000-0000-0000-000000000001', state: 'WAITING_OTTER',
      ownerOtterId: OWNER, waitingOn: null,
    }));

    const changed = await repo.reopenForDissolvedOwner(OWNER, now);
    expect(changed).toBe(1);
    const after = await repo.findById('dddddddd-0000-0000-0000-000000000001');
    expect(after!.state).toBe('OPEN');
  });
});
