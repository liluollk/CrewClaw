/**
 * Workspace Memory：跨会话知识沉淀。
 *
 * 设计要点（边界如实）：
 *  - 四种知识类型 fact/decision/lesson/open_loop：TS 类型 + CHECK 约束双层限定。
 *  - store/item 双 revision compare-and-set：并发编辑返回冲突而非静默覆盖。
 *  - 幂等：idempotencyKey + SHA-256 requestHash——同键同内容重放，同键不同内容拒绝。
 *  - 修订历史：每次变更写不可变 versions 快照；忘记走 tombstone 软删保留审计。
 *  - 检索：FTS5 trigram + bm25 加权；短查询（<3 字符）降级 LIKE 适配中文。
 *  - 隔离：Memory 按 workspace 归属，与聊天历史（Pi session 文件）严格分离。
 *  - 安全边界：进程内直调，不存在伪造跨进程写入的攻击面，故不引入 HMAC 签名链，
 *    信任模型如实收窄为"写入即本地可信"。
 *  - **不是 RAG**：无向量检索、无 embedding，检索走关键词（FTS/LIKE）。
 */
import crypto from 'node:crypto';
import type { DatabaseType } from './database.js';
import { getDatabase } from './database.js';

// ── 类型 ──────────────────────────────────────────────────────────────

export type MemoryKind = 'fact' | 'decision' | 'lesson' | 'open_loop';
export const MEMORY_KINDS: MemoryKind[] = ['fact', 'decision', 'lesson', 'open_loop'];
export type MemoryScope = 'workspace' | 'conversation';

export interface MemoryItem {
  id: string;
  storeId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  status: 'active' | 'deleted';
  importance: number;
  confidence: number;
  revision: number;
  scopeType: MemoryScope;
  scopeKey: string | null;
  createdAt: string;
  updatedAt: string;
}

/** CAS 冲突：调用方提交的 expectedRevision 落后于当前版本 */
export class RevisionConflictError extends Error {
  constructor(
    public currentRevision: number,
    public storeRevision: number,
  ) {
    super(`revision_conflict: 当前 revision=${currentRevision}`);
    this.name = 'RevisionConflictError';
  }
}

/** 幂等键被复用于不同内容 */
export class IdempotencyConflictError extends Error {
  constructor(public existingItemId: string) {
    super('idempotency_conflict: 同一幂等键提交了不同内容');
    this.name = 'IdempotencyConflictError';
  }
}

// ── 内部工具 ──────────────────────────────────────────────────────────

function requestHashOf(input: { kind: MemoryKind; title: string; content: string }): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ kind: input.kind, title: input.title, content: input.content }), 'utf8')
    .digest('hex');
}

function rowToMemory(row: Record<string, unknown>): MemoryItem {
  return {
    id: row.id as string,
    storeId: row.store_id as string,
    kind: row.kind as MemoryKind,
    title: row.title as string,
    content: row.content as string,
    status: row.status as MemoryItem['status'],
    importance: row.importance as number,
    confidence: row.confidence as number,
    revision: row.revision as number,
    scopeType: (row.scope_type as MemoryScope) ?? 'workspace',
    scopeKey: (row.scope_key as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** 取或建 workspace 对应的 store，返回 storeId 与当前 revision */
function ensureStore(d: DatabaseType, workspaceId: string): { storeId: string; revision: number } {
  const existing = d
    .prepare('SELECT id, revision FROM workspace_memory_stores WHERE workspace_id = ?')
    .get(workspaceId) as { id: string; revision: number } | undefined;
  if (existing) return { storeId: existing.id, revision: existing.revision };
  const id = crypto.randomUUID();
  d.prepare('INSERT INTO workspace_memory_stores (id, workspace_id, revision) VALUES (?, ?, 0)').run(id, workspaceId);
  return { storeId: id, revision: 0 };
}

function bumpStore(d: DatabaseType, storeId: string): number {
  d.prepare('UPDATE workspace_memory_stores SET revision = revision + 1, updated_at = datetime(\'now\') WHERE id = ?').run(storeId);
  return (d.prepare('SELECT revision FROM workspace_memory_stores WHERE id = ?').get(storeId) as { revision: number }).revision;
}

function appendVersion(
  d: DatabaseType,
  itemId: string,
  revision: number,
  changeType: 'create' | 'update' | 'forget',
  snapshot: unknown,
): void {
  d.prepare(
    'INSERT INTO workspace_memory_versions (item_id, revision, change_type, snapshot) VALUES (?, ?, ?, ?)',
  ).run(itemId, revision, changeType, JSON.stringify(snapshot));
}

// ── 写路径 ────────────────────────────────────────────────────────────

/**
 * 创建一条记忆。带 idempotencyKey 时：
 *  - 同键 + 同内容 → 重放已存结果（replayed=true）
 *  - 同键 + 不同内容 → IdempotencyConflictError
 */
export function createMemory(
  db: DatabaseType | undefined,
  input: {
    workspaceId: string;
    kind: MemoryKind;
    content: string;
    title?: string;
    importance?: number;
    confidence?: number;
    idempotencyKey?: string;
    scope?: MemoryScope;
    scopeKey?: string;
  },
): { item: MemoryItem; replayed: boolean } {
  if (!MEMORY_KINDS.includes(input.kind)) {
    throw new Error(`非法知识类型: ${input.kind}（必须是 ${MEMORY_KINDS.join('/')}）`);
  }
  const d = db ?? getDatabase();
  const { storeId } = ensureStore(d, input.workspaceId);
  const scope = input.scope ?? 'workspace';
  if (scope === 'conversation' && !input.scopeKey?.trim()) {
    throw new Error('conversation 记忆必须提供 scopeKey');
  }
  const scopeKey = scope === 'conversation' ? input.scopeKey!.trim() : null;

  const requestHash = requestHashOf({ kind: input.kind, title: input.title ?? '', content: input.content });

  return d.transaction(() => {
    if (input.idempotencyKey) {
      const dup = d
        .prepare('SELECT * FROM workspace_memory_items WHERE store_id = ? AND idempotency_key = ?')
        .get(storeId, input.idempotencyKey) as Record<string, unknown> | undefined;
      if (dup) {
        if (dup.request_hash === requestHash) {
          return { item: rowToMemory(dup), replayed: true };
        }
        throw new IdempotencyConflictError(dup.id as string);
      }
    }

    const id = crypto.randomUUID();
    const revision = 1;
    d.prepare(`
      INSERT INTO workspace_memory_items
        (id, store_id, kind, title, content, status, importance, confidence, revision, idempotency_key, request_hash, scope_type, scope_key)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, storeId, input.kind, input.title ?? '', input.content,
      input.importance ?? 0.5, input.confidence ?? 1, revision,
      input.idempotencyKey ?? null, requestHash, scope, scopeKey,
    );
    const item = rowToMemory(
      d.prepare('SELECT * FROM workspace_memory_items WHERE id = ?').get(id) as Record<string, unknown>,
    );
    appendVersion(d, id, revision, 'create', { kind: item.kind, title: item.title, content: item.content });
    d.prepare('INSERT INTO workspace_memory_fts (item_id, store_id, title, content) VALUES (?, ?, ?, ?)').run(
      id, storeId, item.title, item.content,
    );
    bumpStore(d, storeId);
    return { item, replayed: false };
  })();
}

/** 更新记忆（CAS：expectedRevision 必须等于当前 revision，否则 409 语义冲突） */
export function updateMemory(
  db: DatabaseType | undefined,
  input: { itemId: string; expectedRevision: number; content: string; title?: string; workspaceId?: string },
): MemoryItem {
  const d = db ?? getDatabase();
  return d.transaction(() => {
    const cur = d.prepare(`
      SELECT m.* FROM workspace_memory_items m
      JOIN workspace_memory_stores s ON s.id = m.store_id
      WHERE m.id = ? AND (? IS NULL OR s.workspace_id = ?)
    `).get(input.itemId, input.workspaceId ?? null, input.workspaceId ?? null) as
      | Record<string, unknown>
      | undefined;
    if (!cur) throw new Error(`记忆不存在: ${input.itemId}`);
    if (cur.status === 'deleted' || cur.revision !== input.expectedRevision) {
      throw new RevisionConflictError(cur.revision as number, 0);
    }
    const newRevision = (cur.revision as number) + 1;
    const res = d.prepare(`
      UPDATE workspace_memory_items
      SET title = ?, content = ?, revision = ?, updated_at = datetime('now')
      WHERE id = ? AND revision = ? AND status = 'active'
    `).run(input.title ?? cur.title, input.content, newRevision, input.itemId, input.expectedRevision);
    if (res.changes !== 1) {
      const latest = d.prepare('SELECT revision FROM workspace_memory_items WHERE id = ?').get(input.itemId) as
        | { revision: number }
        | undefined;
      throw new RevisionConflictError(latest?.revision ?? -1, 0);
    }
    const item = rowToMemory(
      d.prepare('SELECT * FROM workspace_memory_items WHERE id = ?').get(input.itemId) as Record<string, unknown>,
    );
    appendVersion(d, item.id, newRevision, 'update', { kind: item.kind, title: item.title, content: item.content });
    // FTS 同步：删旧行、插新行
    d.prepare('DELETE FROM workspace_memory_fts WHERE item_id = ?').run(item.id);
    d.prepare('INSERT INTO workspace_memory_fts (item_id, store_id, title, content) VALUES (?, ?, ?, ?)').run(
      item.id, item.storeId, item.title, item.content,
    );
    bumpStore(d, item.storeId);
    return item;
  })();
}

/** 忘记一条记忆（软删 + 墓碑审计 + FTS 移除，同样走 CAS） */
export function forgetMemory(
  db: DatabaseType | undefined,
  input: { itemId: string; expectedRevision: number; reason?: string; actor?: string; workspaceId?: string },
): void {
  const d = db ?? getDatabase();
  d.transaction(() => {
    const cur = d.prepare(`
      SELECT m.* FROM workspace_memory_items m
      JOIN workspace_memory_stores s ON s.id = m.store_id
      WHERE m.id = ? AND (? IS NULL OR s.workspace_id = ?)
    `).get(input.itemId, input.workspaceId ?? null, input.workspaceId ?? null) as
      | Record<string, unknown>
      | undefined;
    if (!cur) throw new Error(`记忆不存在: ${input.itemId}`);
    if (cur.status === 'deleted' || cur.revision !== input.expectedRevision) {
      throw new RevisionConflictError(cur.revision as number, 0);
    }
    const newRevision = (cur.revision as number) + 1;
    d.prepare(`
      UPDATE workspace_memory_items
      SET status = 'deleted', revision = ?, updated_at = datetime('now')
      WHERE id = ? AND revision = ?
    `).run(newRevision, input.itemId, input.expectedRevision);
    d.prepare(
      'INSERT INTO workspace_memory_tombstones (item_id, deleted_revision, reason, actor) VALUES (?, ?, ?, ?)',
    ).run(input.itemId, newRevision, input.reason ?? '', input.actor ?? 'local');
    appendVersion(d, input.itemId, newRevision, 'forget', { forgotten: true });
    d.prepare('DELETE FROM workspace_memory_fts WHERE item_id = ?').run(input.itemId);
    bumpStore(d, cur.store_id as string);
  })();
}

// ── 读路径 ────────────────────────────────────────────────────────────

export function getMemory(db: DatabaseType | undefined, itemId: string): MemoryItem | null {
  const d = db ?? getDatabase();
  const row = d.prepare('SELECT * FROM workspace_memory_items WHERE id = ?').get(itemId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToMemory(row) : null;
}

/** recallable 列表：按 importance DESC, updated_at DESC 取前 N 条 */
export function listRecallable(
  db: DatabaseType | undefined,
  input: { workspaceId: string; limit?: number; sessionKey?: string },
): MemoryItem[] {
  const d = db ?? getDatabase();
  const store = d
    .prepare('SELECT id FROM workspace_memory_stores WHERE workspace_id = ?')
    .get(input.workspaceId) as { id: string } | undefined;
  if (!store) return [];
  const rows = d
    .prepare(`
      SELECT * FROM workspace_memory_items
      WHERE store_id = ? AND status = 'active'
        AND (scope_type = 'workspace' OR (scope_type = 'conversation' AND scope_key = ?))
      ORDER BY importance DESC, updated_at DESC
      LIMIT ?
    `)
    .all(store.id, input.sessionKey ?? '', input.limit ?? 10) as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}

/**
 * 检索：查询词 ≥3 字符走 FTS5 trigram + bm25（title 权重 3、content 权重 2）；
 * 短查询降级 LIKE（trigram 需要 3 字符，中文两字词如"改价"必须走这条路）。
 */
export function searchMemory(
  db: DatabaseType | undefined,
  input: { workspaceId: string; query: string; limit?: number; sessionKey?: string },
): MemoryItem[] {
  const d = db ?? getDatabase();
  const store = d
    .prepare('SELECT id FROM workspace_memory_stores WHERE workspace_id = ?')
    .get(input.workspaceId) as { id: string } | undefined;
  if (!store) return [];
  const limit = input.limit ?? 10;
  const q = input.query.trim();
  if (!q) return listRecallable(d, { workspaceId: input.workspaceId, limit, sessionKey: input.sessionKey });

  if (q.length >= 3) {
    try {
      const rows = d
        .prepare(`
          SELECT m.* FROM workspace_memory_fts f
          JOIN workspace_memory_items m ON m.id = f.item_id
          WHERE workspace_memory_fts MATCH ? AND f.store_id = ? AND m.status = 'active'
            AND (m.scope_type = 'workspace' OR (m.scope_type = 'conversation' AND m.scope_key = ?))
          ORDER BY bm25(workspace_memory_fts, 3.0, 2.0)
          LIMIT ?
        `)
        .all(`"${q.replace(/"/g, '""')}"`, store.id, input.sessionKey ?? '', limit) as Array<Record<string, unknown>>;
      return rows.map(rowToMemory);
    } catch {
      // trigram 语法边界（如含特殊符号）失败 → 降级 LIKE
    }
  }
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = d
    .prepare(`
      SELECT * FROM workspace_memory_items
      WHERE store_id = ? AND status = 'active'
        AND (scope_type = 'workspace' OR (scope_type = 'conversation' AND scope_key = ?))
        AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
      ORDER BY importance DESC, updated_at DESC
      LIMIT ?
    `)
    .all(store.id, input.sessionKey ?? '', like, like, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}

/** 修订历史（不可变快照序列，按 revision 降序） */
export function listMemoryVersions(
  db: DatabaseType | undefined,
  itemId: string,
  workspaceId?: string,
): Array<{ revision: number; changeType: string; snapshot: string; createdAt: string }> {
  const d = db ?? getDatabase();
  const rows = d
    .prepare(`
      SELECT v.* FROM workspace_memory_versions v
      JOIN workspace_memory_items m ON m.id = v.item_id
      JOIN workspace_memory_stores s ON s.id = m.store_id
      WHERE v.item_id = ? AND (? IS NULL OR s.workspace_id = ?)
      ORDER BY v.revision DESC
    `)
    .all(itemId, workspaceId ?? null, workspaceId ?? null) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    revision: r.revision as number,
    changeType: r.change_type as string,
    snapshot: r.snapshot as string,
    createdAt: r.created_at as string,
  }));
}
