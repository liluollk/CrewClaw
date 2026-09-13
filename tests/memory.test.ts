/**
 * Workspace Memory 测试。
 * 覆盖：四种知识类型约束、幂等重放与冲突、双 revision CAS、忘记软删+审计、
 * FTS trigram 检索与短查询 LIKE 降级、workspace 隔离、不可变修订历史。
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/core/database.js';
import {
  createMemory,
  updateMemory,
  forgetMemory,
  getMemory,
  searchMemory,
  listRecallable,
  listMemoryVersions,
  RevisionConflictError,
  IdempotencyConflictError,
} from '../src/memory/memory.js';

function freshDb() {
  const db = new Database(':memory:');
  initDatabase(db);
  return db;
}

describe('P5 · 创建与类型约束', () => {
  it('创建记忆返回 active、revision=1', () => {
    const db = freshDb();
    const { item, replayed } = createMemory(db, {
      workspaceId: 'ws1', kind: 'decision', content: '迁移采用 SQLite 单文件方案',
    });
    expect(replayed).toBe(false);
    expect(item.status).toBe('active');
    expect(item.revision).toBe(1);
    expect(item.kind).toBe('decision');
    expect(getMemory(db, item.id)!.content).toBe('迁移采用 SQLite 单文件方案');
    db.close();
  });

  it('非法知识类型被拒绝（TS + CHECK 双层中的 TS 层）', () => {
    const db = freshDb();
    expect(() =>
      createMemory(db, { workspaceId: 'ws1', kind: 'rumor' as never, content: 'x' }),
    ).toThrow('非法知识类型');
    db.close();
  });

  it('DB CHECK 兜底：绕过 TS 直接插入非法 kind 被拒', () => {
    const db = freshDb();
    createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: 'ok' });
    expect(() =>
      db.prepare(
        "INSERT INTO workspace_memory_items (id, store_id, kind, content) VALUES ('x','s','rumor','y')",
      ).run(),
    ).toThrow();
    db.close();
  });
});

describe('P5 · 记忆作用域', () => {
  it('查询当前会话时返回团队记忆和当前会话记忆', () => {
    const db = freshDb();
    createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: '团队约定：周报周五提交', scope: 'workspace' });
    createMemory(db, {
      workspaceId: 'ws1', kind: 'decision', content: '运营群约定：每天九点同步库存',
      scope: 'conversation', scopeKey: 'channel:feishu#conv:ops',
    });
    createMemory(db, {
      workspaceId: 'ws1', kind: 'decision', content: '销售群约定：报价需带有效期',
      scope: 'conversation', scopeKey: 'channel:feishu#conv:sales',
    });

    const hits = searchMemory(db, { workspaceId: 'ws1', query: '约定', sessionKey: 'channel:feishu#conv:ops' });
    expect(hits).toHaveLength(2);
    expect(hits.map((item) => item.content)).toEqual(expect.arrayContaining([
      '团队约定：周报周五提交',
      '运营群约定：每天九点同步库存',
    ]));
    db.close();
  });

  it('当前会话检索不会返回另一个会话的专属记忆', () => {
    const db = freshDb();
    createMemory(db, {
      workspaceId: 'ws1', kind: 'decision', content: '销售群约定：报价需带有效期',
      scope: 'conversation', scopeKey: 'channel:feishu#conv:sales',
    });
    const hits = searchMemory(db, { workspaceId: 'ws1', query: '报价', sessionKey: 'channel:feishu#conv:ops' });
    expect(hits).toHaveLength(0);
    db.close();
  });

  it('未指定作用域的旧式写入默认是团队记忆', () => {
    const db = freshDb();
    const { item } = createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: '旧数据' });
    expect(item.scopeType).toBe('workspace');
    expect(item.scopeKey).toBeNull();
    db.close();
  });
});

describe('P5 · 幂等', () => {
  it('同键同内容 → 重放已存结果', () => {
    const db = freshDb();
    const a = createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: '生产库为 PG15', idempotencyKey: 'k1' });
    const b = createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: '生产库为 PG15', idempotencyKey: 'k1' });
    expect(b.replayed).toBe(true);
    expect(b.item.id).toBe(a.item.id);
    db.close();
  });

  it('同键不同内容 → IdempotencyConflictError', () => {
    const db = freshDb();
    createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: 'A', idempotencyKey: 'k1' });
    expect(() =>
      createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: 'B', idempotencyKey: 'k1' }),
    ).toThrow(IdempotencyConflictError);
    db.close();
  });
});

describe('P5 · 双 revision CAS', () => {
  it('正确 expectedRevision → 更新成功且 revision+1', () => {
    const db = freshDb();
    const { item } = createMemory(db, { workspaceId: 'ws1', kind: 'lesson', content: '旧内容' });
    const updated = updateMemory(db, { itemId: item.id, expectedRevision: 1, content: '新内容' });
    expect(updated.revision).toBe(2);
    expect(updated.content).toBe('新内容');
    db.close();
  });

  it('过期 expectedRevision → RevisionConflictError（并发不静默覆盖）', () => {
    const db = freshDb();
    const { item } = createMemory(db, { workspaceId: 'ws1', kind: 'lesson', content: 'a' });
    updateMemory(db, { itemId: item.id, expectedRevision: 1, content: 'b' });
    // 第二个客户端拿着旧 revision=1 来更新
    try {
      updateMemory(db, { itemId: item.id, expectedRevision: 1, content: 'c' });
      expect.unreachable('应抛冲突');
    } catch (err) {
      expect(err).toBeInstanceOf(RevisionConflictError);
      expect((err as RevisionConflictError).currentRevision).toBe(2);
    }
    // 旧客户端的内容没有覆盖成功
    expect(getMemory(db, item.id)!.content).toBe('b');
    db.close();
  });

  it('store revision 随写入递增', () => {
    const db = freshDb();
    const { item } = createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: 'a' });
    const s1 = db.prepare('SELECT revision FROM workspace_memory_stores WHERE workspace_id = ?').get('ws1') as { revision: number };
    updateMemory(db, { itemId: item.id, expectedRevision: 1, content: 'b' });
    const s2 = db.prepare('SELECT revision FROM workspace_memory_stores WHERE workspace_id = ?').get('ws1') as { revision: number };
    expect(s2.revision).toBeGreaterThan(s1.revision);
    db.close();
  });
});

describe('P5 · 忘记（软删 + 审计）', () => {
  it('forget 后检索不再命中，但行与墓碑保留', () => {
    const db = freshDb();
    const { item } = createMemory(db, { workspaceId: 'ws1', kind: 'open_loop', content: '等待客户确认配额上限' });
    forgetMemory(db, { itemId: item.id, expectedRevision: 1, reason: '已关闭' });
    expect(searchMemory(db, { workspaceId: 'ws1', query: '配额上限' })).toHaveLength(0);
    expect(getMemory(db, item.id)!.status).toBe('deleted');
    const tomb = db.prepare('SELECT * FROM workspace_memory_tombstones WHERE item_id = ?').get(item.id) as { reason: string };
    expect(tomb.reason).toBe('已关闭');
    db.close();
  });
});

describe('P5 · 检索', () => {
  it('FTS trigram：≥3 字符查询命中', () => {
    const db = freshDb();
    createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: '生产数据库是 PostgreSQL 15' });
    createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: '测试数据库是 SQLite' });
    const hits = searchMemory(db, { workspaceId: 'ws1', query: 'PostgreSQL' });
    expect(hits.some((h) => h.content.includes('PostgreSQL 15'))).toBe(true);
    db.close();
  });

  it('中文短查询降级 LIKE：两字词也能命中', () => {
    const db = freshDb();
    createMemory(db, { workspaceId: 'ws1', kind: 'decision', content: '恢复演练通过后再切生产' });
    const hits = searchMemory(db, { workspaceId: 'ws1', query: '恢复' }); // 2 字符 < trigram 窗口
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain('恢复');
    db.close();
  });

  it('recallable 按 importance 优先排序', () => {
    const db = freshDb();
    createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: '低', importance: 0.2 });
    createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: '高', importance: 0.9 });
    const list = listRecallable(db, { workspaceId: 'ws1' });
    expect(list[0].content).toBe('高');
    db.close();
  });
});

describe('P5 · workspace 隔离与版本史', () => {
  it('不同 workspace 的记忆互不可见', () => {
    const db = freshDb();
    createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: 'ws1 专属事实' });
    createMemory(db, { workspaceId: 'ws2', kind: 'fact', content: 'ws2 专属事实' });
    expect(searchMemory(db, { workspaceId: 'ws1', query: '专属事实' }).every((m) => m.content.includes('ws1'))).toBe(true);
    expect(listRecallable(db, { workspaceId: 'ws2' })).toHaveLength(1);
    db.close();
  });

  it('修订历史保留每次变更的不可变快照', () => {
    const db = freshDb();
    const { item } = createMemory(db, { workspaceId: 'ws1', kind: 'fact', content: 'v1' });
    updateMemory(db, { itemId: item.id, expectedRevision: 1, content: 'v2' });
    forgetMemory(db, { itemId: item.id, expectedRevision: 2 });
    const versions = listMemoryVersions(db, item.id);
    expect(versions.map((v) => v.changeType)).toEqual(['forget', 'update', 'create']);
    expect(versions.map((v) => v.revision)).toEqual([3, 2, 1]);
    db.close();
  });
});
