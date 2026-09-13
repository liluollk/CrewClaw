/**
 * Agent-First 三层产品模型与身份哈希。
 *
 * 设计要点：
 *  - Profile（身份与策略所有者）→ Workspace（文件隔离边界）→ Runtime Session（执行记录）。
 *  - identity_hash：SHA-256(四段提示词 + runtime_policy + name)，变更时 version+=1。
 *  - folder 正则约束 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，防路径穿越。
 *  - prompt 版本快照不可变：agent_profile_prompt_versions 表。
 *  - 兼容映射：现有 sessionName 目录结构 → 投影到 runtime_sessions 表。
 */
import crypto from 'node:crypto';
import { getDatabase, assertSchema, type DatabaseType } from './database.js';

// ── 类型定义 ──────────────────────────────────────────────────────────

export interface AgentProfile {
  id: string;
  name: string;
  identityPrompt: string;
  soulPrompt: string;
  agentsPrompt: string;
  toolsPrompt: string;
  runtimePolicy: Record<string, unknown>;
  identityHash: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  folder: string;
  owner: string;
  createdAt: string;
}

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  username: string;
  displayName: string;
  role: WorkspaceRole;
  createdAt: string;
}

export interface WorkspaceAgentBinding {
  workspaceId: string;
  profileId: string;
  interactionMode: string;
}

export interface RuntimeSession {
  id: string;
  workspaceId: string;
  profileId: string;
  sessionKey: string;
  lastUsedAt: string;
  metadata: Record<string, unknown>;
}

export interface PromptVersionSnapshot {
  profileId: string;
  version: number;
  identityHash: string;
  snapshot: string;
  createdAt: string;
}

// ── Folder 校验 ───────────────────────────────────────────────────────

/** folder 正则：字母数字开头，最长 128 字符，仅含字母数字._- */
export const FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateFolder(folder: string): boolean {
  return FOLDER_PATTERN.test(folder);
}

// ── 身份哈希 ──────────────────────────────────────────────────────────

/**
 * 确定性序列化：递归排序对象键，保证任意层级的内容变化都会反映到字符串上。
 * （JSON.stringify 的 replacer 数组会过滤所有层级的键，嵌套字段会被静默丢弃——不可用于哈希输入。）
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * 计算 identity_hash：SHA-256(四段提示词 + runtime_policy + name)。
 * 用于检测身份变更并触发 version+=1。
 */
export function computeIdentityHash(profile: {
  identityPrompt: string;
  soulPrompt: string;
  agentsPrompt: string;
  toolsPrompt: string;
  runtimePolicy: Record<string, unknown>;
  name: string;
}): string {
  const input = [
    profile.identityPrompt,
    profile.soulPrompt,
    profile.agentsPrompt,
    profile.toolsPrompt,
    stableStringify(profile.runtimePolicy),
    profile.name,
  ].join('\x00');
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// ── 数据库行 ↔ 对象转换 ──────────────────────────────────────────────

function rowToProfile(row: Record<string, unknown>): AgentProfile {
  return {
    id: row.id as string,
    name: row.name as string,
    identityPrompt: row.identity_prompt as string,
    soulPrompt: row.soul_prompt as string,
    agentsPrompt: row.agents_prompt as string,
    toolsPrompt: row.tools_prompt as string,
    runtimePolicy: JSON.parse(row.runtime_policy as string),
    identityHash: row.identity_hash as string,
    version: row.version as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as string,
    name: row.name as string,
    folder: row.folder as string,
    owner: row.owner as string,
    createdAt: row.created_at as string,
  };
}

function rowToBinding(row: Record<string, unknown>): WorkspaceAgentBinding {
  return {
    workspaceId: row.workspace_id as string,
    profileId: row.profile_id as string,
    interactionMode: row.interaction_mode as string,
  };
}

function rowToSession(row: Record<string, unknown>): RuntimeSession {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    profileId: row.profile_id as string,
    sessionKey: row.session_key as string,
    lastUsedAt: row.last_used_at as string,
    metadata: JSON.parse(row.metadata as string),
  };
}

// ── AgentProfile CRUD ─────────────────────────────────────────────────

export function createAgentProfile(
  db: DatabaseType | undefined,
  input: {
    id: string;
    name: string;
    identityPrompt?: string;
    soulPrompt?: string;
    agentsPrompt?: string;
    toolsPrompt?: string;
    runtimePolicy?: Record<string, unknown>;
  },
): AgentProfile {
  const d = db ?? getDatabase();
  const profile = {
    id: input.id,
    name: input.name,
    identityPrompt: input.identityPrompt ?? '',
    soulPrompt: input.soulPrompt ?? '',
    agentsPrompt: input.agentsPrompt ?? '',
    toolsPrompt: input.toolsPrompt ?? '',
    runtimePolicy: input.runtimePolicy ?? {},
  };
  const hash = computeIdentityHash(profile);
  const stmt = d.prepare(`
    INSERT INTO agent_profiles (id, name, identity_prompt, soul_prompt, agents_prompt, tools_prompt, runtime_policy, identity_hash, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  stmt.run(
    profile.id, profile.name,
    profile.identityPrompt, profile.soulPrompt,
    profile.agentsPrompt, profile.toolsPrompt,
    JSON.stringify(profile.runtimePolicy),
    hash,
  );
  // 写入不可变快照（v1）
  savePromptSnapshot(d, profile.id, 1, hash, profile);
  return getAgentProfile(d, profile.id)!;
}

export function getAgentProfile(db: DatabaseType | undefined, id: string): AgentProfile | null {
  const d = db ?? getDatabase();
  const row = d.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToProfile(row) : null;
}

export function listAgentProfiles(db: DatabaseType | undefined): AgentProfile[] {
  const d = db ?? getDatabase();
  const rows = d.prepare('SELECT * FROM agent_profiles ORDER BY created_at DESC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToProfile);
}

/**
 * 更新 AgentProfile 的提示词或策略。
 * 如果内容变化 → identity_hash 变化 → version+=1 → 写入不可变快照。
 */
export function updateAgentProfile(
  db: DatabaseType | undefined,
  id: string,
  input: Partial<{
    name: string;
    identityPrompt: string;
    soulPrompt: string;
    agentsPrompt: string;
    toolsPrompt: string;
    runtimePolicy: Record<string, unknown>;
  }>,
): AgentProfile | null {
  const d = db ?? getDatabase();
  const existing = getAgentProfile(d, id);
  if (!existing) return null;

  const merged = {
    name: input.name ?? existing.name,
    identityPrompt: input.identityPrompt ?? existing.identityPrompt,
    soulPrompt: input.soulPrompt ?? existing.soulPrompt,
    agentsPrompt: input.agentsPrompt ?? existing.agentsPrompt,
    toolsPrompt: input.toolsPrompt ?? existing.toolsPrompt,
    runtimePolicy: input.runtimePolicy ?? existing.runtimePolicy,
  };
  const newHash = computeIdentityHash(merged);

  if (newHash === existing.identityHash) {
    // 内容无变化，只更新 updated_at
    d.prepare('UPDATE agent_profiles SET updated_at = datetime(\'now\') WHERE id = ?').run(id);
    return getAgentProfile(d, id);
  }

  const newVersion = existing.version + 1;
  // UPDATE 与快照写入必须同事务：否则快照失败会留下"版本已加但无快照"的不一致状态
  d.transaction(() => {
    d.prepare(`
      UPDATE agent_profiles
      SET name = ?, identity_prompt = ?, soul_prompt = ?, agents_prompt = ?, tools_prompt = ?,
          runtime_policy = ?, identity_hash = ?, version = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      merged.name, merged.identityPrompt, merged.soulPrompt,
      merged.agentsPrompt, merged.toolsPrompt,
      JSON.stringify(merged.runtimePolicy), newHash, newVersion, id,
    );
    savePromptSnapshot(d, id, newVersion, newHash, merged);
  })();
  return getAgentProfile(d, id);
}

function savePromptSnapshot(
  db: DatabaseType,
  profileId: string,
  version: number,
  hash: string,
  profile: {
    name: string;
    identityPrompt: string;
    soulPrompt: string;
    agentsPrompt: string;
    toolsPrompt: string;
    runtimePolicy: Record<string, unknown>;
  },
): void {
  const snapshot = JSON.stringify({
    name: profile.name,
    identityPrompt: profile.identityPrompt,
    soulPrompt: profile.soulPrompt,
    agentsPrompt: profile.agentsPrompt,
    toolsPrompt: profile.toolsPrompt,
    runtimePolicy: profile.runtimePolicy,
  });
  db.prepare(`
    INSERT OR IGNORE INTO agent_profile_prompt_versions (profile_id, version, identity_hash, snapshot)
    VALUES (?, ?, ?, ?)
  `).run(profileId, version, hash, snapshot);
}

// ── Workspace CRUD ────────────────────────────────────────────────────

export function createWorkspace(
  db: DatabaseType | undefined,
  input: { id: string; name: string; folder: string; owner?: string },
): Workspace {
  if (!validateFolder(input.folder)) {
    throw new Error(`非法 folder 名称: "${input.folder}"。必须匹配 ${FOLDER_PATTERN}`);
  }
  const d = db ?? getDatabase();
  const stmt = d.prepare(`
    INSERT INTO workspaces (id, name, folder, owner)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(input.id, input.name, input.folder, input.owner ?? '');
  return getWorkspace(d, input.id)!;
}

export function getWorkspace(db: DatabaseType | undefined, id: string): Workspace | null {
  const d = db ?? getDatabase();
  const row = d.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToWorkspace(row) : null;
}

export function getWorkspaceByFolder(db: DatabaseType | undefined, folder: string): Workspace | null {
  const d = db ?? getDatabase();
  const row = d.prepare('SELECT * FROM workspaces WHERE folder = ?').get(folder) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToWorkspace(row) : null;
}

export function listWorkspaces(db: DatabaseType | undefined): Workspace[] {
  const d = db ?? getDatabase();
  const rows = d.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToWorkspace);
}

// ── Workspace 成员 ───────────────────────────────────────────────────

export function addWorkspaceMember(
  db: DatabaseType | undefined,
  input: { workspaceId: string; userId: string; role?: WorkspaceRole },
): WorkspaceMember {
  const d = db ?? getDatabase();
  const role = input.role ?? 'member';
  if (!['owner', 'admin', 'member'].includes(role)) {
    throw new Error(`非法 Workspace 角色: ${role}`);
  }
  const id = `wm-${crypto.randomUUID()}`;
  d.prepare(`
    INSERT INTO workspace_members (id, workspace_id, user_id, role)
    VALUES (?, ?, ?, ?)
  `).run(id, input.workspaceId, input.userId, role);
  const member = getWorkspaceMembership(d, input.workspaceId, input.userId);
  if (!member) throw new Error(`Workspace 成员写入失败: ${input.workspaceId}/${input.userId}`);
  return member;
}

export function getWorkspaceMembership(
  db: DatabaseType | undefined,
  workspaceId: string,
  userId: string,
): WorkspaceMember | null {
  const d = db ?? getDatabase();
  const row = d.prepare(`
    SELECT wm.*, u.username, u.display_name
    FROM workspace_members wm
    LEFT JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ? AND wm.user_id = ?
  `).get(workspaceId, userId) as Record<string, unknown> | undefined;
  return row ? rowToWorkspaceMember(row) : null;
}

export function listWorkspaceMembers(
  db: DatabaseType | undefined,
  workspaceId: string,
): WorkspaceMember[] {
  const d = db ?? getDatabase();
  const rows = d.prepare(`
    SELECT wm.*, u.username, u.display_name
    FROM workspace_members wm
    LEFT JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ?
    ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, wm.created_at
  `).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(rowToWorkspaceMember);
}

export function requireWorkspaceMembership(
  db: DatabaseType | undefined,
  workspaceId: string,
  userId: string,
): WorkspaceMember {
  const member = getWorkspaceMembership(db, workspaceId, userId);
  if (!member) throw new Error(`无权访问 Workspace: ${workspaceId}`);
  return member;
}

// ── 桥接 CRUD ─────────────────────────────────────────────────────────

export function bindProfileToWorkspace(
  db: DatabaseType | undefined,
  workspaceId: string,
  profileId: string,
  interactionMode?: string,
): WorkspaceAgentBinding {
  const d = db ?? getDatabase();
  d.prepare(`
    INSERT OR REPLACE INTO workspace_agent_profiles (workspace_id, profile_id, interaction_mode)
    VALUES (?, ?, ?)
  `).run(workspaceId, profileId, interactionMode ?? 'chat');
  const row = d.prepare(
    'SELECT * FROM workspace_agent_profiles WHERE workspace_id = ? AND profile_id = ?',
  ).get(workspaceId, profileId) as Record<string, unknown>;
  return rowToBinding(row);
}

export function getBindingsForWorkspace(
  db: DatabaseType | undefined,
  workspaceId: string,
): WorkspaceAgentBinding[] {
  const d = db ?? getDatabase();
  const rows = d.prepare(
    'SELECT * FROM workspace_agent_profiles WHERE workspace_id = ?',
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(rowToBinding);
}

// ── RuntimeSession CRUD ───────────────────────────────────────────────

export function recordRuntimeSession(
  db: DatabaseType | undefined,
  input: {
    id: string;
    workspaceId: string;
    profileId: string;
    sessionKey: string;
    metadata?: Record<string, unknown>;
  },
): RuntimeSession {
  const d = db ?? getDatabase();
  d.prepare(`
    INSERT OR REPLACE INTO workspace_runtime_sessions (id, workspace_id, profile_id, session_key, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.id, input.workspaceId, input.profileId, input.sessionKey, JSON.stringify(input.metadata ?? {}));
  const row = d.prepare('SELECT * FROM workspace_runtime_sessions WHERE id = ?').get(input.id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`RuntimeSession 记录失败：id=${input.id}`);
  return rowToSession(row);
}

export function getRuntimeSessionByKey(
  db: DatabaseType | undefined,
  sessionKey: string,
): RuntimeSession | null {
  const d = db ?? getDatabase();
  const row = d.prepare('SELECT * FROM workspace_runtime_sessions WHERE session_key = ?').get(sessionKey) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSession(row) : null;
}

export function listRuntimeSessions(
  db: DatabaseType | undefined,
  workspaceId: string,
): RuntimeSession[] {
  const d = db ?? getDatabase();
  const rows = d.prepare(
    'SELECT * FROM workspace_runtime_sessions WHERE workspace_id = ? ORDER BY last_used_at DESC',
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(rowToSession);
}

// ── Prompt 版本快照查询 ───────────────────────────────────────────────

export function getPromptVersionSnapshots(
  db: DatabaseType | undefined,
  profileId: string,
): PromptVersionSnapshot[] {
  const d = db ?? getDatabase();
  const rows = d.prepare(
    'SELECT * FROM agent_profile_prompt_versions WHERE profile_id = ? ORDER BY version DESC',
  ).all(profileId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    profileId: r.profile_id as string,
    version: r.version as number,
    identityHash: r.identity_hash as string,
    snapshot: r.snapshot as string,
    createdAt: r.created_at as string,
  }));
}

// ── 对话历史底账（chat_messages，v4） ─────────────────────────────────

export interface ChatMessage {
  id: string;
  sessionKey: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

export function appendChatMessage(
  db: DatabaseType | undefined,
  input: {
    sessionKey: string;
    role: ChatMessage['role'];
    content: string;
    meta?: Record<string, unknown>;
  },
): ChatMessage {
  const d = db ?? getDatabase();
  const id = crypto.randomUUID();
  d.prepare(`
    INSERT INTO chat_messages (id, session_key, role, content, meta)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, input.sessionKey, input.role, input.content, JSON.stringify(input.meta ?? {}));
  const row = d.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as Record<string, unknown>;
  return {
    id: row.id as string,
    sessionKey: row.session_key as string,
    role: row.role as ChatMessage['role'],
    content: row.content as string,
    meta: JSON.parse((row.meta as string) || '{}'),
    createdAt: row.created_at as string,
  };
}

export function listChatMessages(
  db: DatabaseType | undefined,
  input: { sessionKey: string; limit?: number },
): ChatMessage[] {
  const d = db ?? getDatabase();
  // 按 rowid（插入序）取：created_at 是秒级粒度，同秒内的消息顺序靠它不稳定
  const rows = d.prepare(`
    SELECT * FROM chat_messages WHERE session_key = ? ORDER BY rowid DESC LIMIT ?
  `).all(input.sessionKey, Math.min(input.limit ?? 100, 500)) as Array<Record<string, unknown>>;
  return rows
    .map((row) => ({
      id: row.id as string,
      sessionKey: row.session_key as string,
      role: row.role as ChatMessage['role'],
      content: row.content as string,
      meta: JSON.parse((row.meta as string) || '{}'),
      createdAt: row.created_at as string,
    }))
    .reverse(); // 按时间正序返回，前端直接渲染
}

// ── 工具调用审计底账（tool_calls，v8） ────────────────────────────────

export type ToolCallStatus = 'pending' | 'approved' | 'rejected' | 'auto';

export interface ToolCallRecord {
  id: string;
  agentId: string;
  workspaceId: string;
  sessionKey: string;
  toolName: string;
  input: Record<string, unknown>;
  status: ToolCallStatus;
  resultText: string;
  triggerType: string;
  actorUserId: string;
  createdAt: string;
}

export function recordToolCall(
  db: DatabaseType | undefined,
  input: {
    agentId?: string;
    workspaceId?: string;
    sessionKey?: string;
    toolName: string;
    input?: Record<string, unknown>;
    status?: ToolCallStatus;
    resultText?: string;
    triggerType?: string;
    actorUserId?: string;
  },
): ToolCallRecord {
  const d = db ?? getDatabase();
  const id = crypto.randomUUID();
  d.prepare(`
    INSERT INTO tool_calls (id, agent_id, workspace_id, session_key, tool_name, input, status, result_text, trigger_type, actor_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.agentId ?? '',
    input.workspaceId ?? '',
    input.sessionKey ?? '',
    input.toolName,
    JSON.stringify(input.input ?? {}),
    input.status ?? 'auto',
    input.resultText ?? '',
    input.triggerType ?? 'message',
    input.actorUserId ?? '',
  );
  const row = d.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as Record<string, unknown>;
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    workspaceId: row.workspace_id as string,
    sessionKey: row.session_key as string,
    toolName: row.tool_name as string,
    input: JSON.parse((row.input as string) || '{}'),
    status: row.status as ToolCallStatus,
    resultText: row.result_text as string,
    triggerType: row.trigger_type as string,
    actorUserId: (row.actor_user_id as string) || '',
    createdAt: row.created_at as string,
  };
}

export function listToolCalls(
  db: DatabaseType | undefined,
  input: { agentId?: string; workspaceId?: string; limit?: number },
): ToolCallRecord[] {
  const d = db ?? getDatabase();
  const conds: string[] = [];
  const params: string[] = [];
  if (input.agentId) { conds.push('agent_id = ?'); params.push(input.agentId); }
  if (input.workspaceId) { conds.push('workspace_id = ?'); params.push(input.workspaceId); }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = d.prepare(`
    SELECT * FROM tool_calls ${where} ORDER BY created_at DESC LIMIT ?
  `).all(...params, Math.min(input.limit ?? 100, 500)) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    agentId: row.agent_id as string,
    workspaceId: row.workspace_id as string,
    sessionKey: row.session_key as string,
    toolName: row.tool_name as string,
    input: JSON.parse((row.input as string) || '{}'),
    status: row.status as ToolCallStatus,
    resultText: row.result_text as string,
    triggerType: row.trigger_type as string,
    actorUserId: (row.actor_user_id as string) || '',
    createdAt: row.created_at as string,
  }));
}

// ── 用户工作区引导（多用户隔离的入口） ────────────────────────────────

/**
 * 取（或建）用户的主工作区。注册后首次调用即完成"一人一空间"；
 * 早期存量 workspace（owner 为空）由首个注册用户接管。
 */
export function ensureUserWorkspace(db: DatabaseType | undefined, user: { id: string; username: string; displayName?: string }): Workspace {
  const d = db ?? getDatabase();
  const existing = d
    .prepare(`
      SELECT w.*
      FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = ?
      ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, w.created_at
      LIMIT 1
    `)
    .get(user.id) as Record<string, unknown> | undefined;
  if (existing) return rowToWorkspace(existing);

  // 接管无主工作区（迁移升级场景：老库里的 ws-web 归第一个用户）
  const orphan = d
    .prepare("SELECT * FROM workspaces WHERE owner = '' OR owner IS NULL ORDER BY created_at LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  if (orphan) {
    d.prepare('UPDATE workspaces SET owner = ? WHERE id = ?').run(user.id, orphan.id);
    addWorkspaceMember(d, { workspaceId: orphan.id as string, userId: user.id, role: 'owner' });
    return rowToWorkspace(
      d.prepare('SELECT * FROM workspaces WHERE id = ?').get(orphan.id) as Record<string, unknown>,
    );
  }

  const uid = user.id.replace(/-/g, '');
  const workspace = createWorkspace(d, {
    id: `ws-${uid.slice(0, 12)}`,
    name: `${user.displayName || user.username} 的空间`,
    folder: `u${uid.slice(0, 12)}`,
    owner: user.id,
  });
  addWorkspaceMember(d, { workspaceId: workspace.id, userId: user.id, role: 'owner' });
  return workspace;
}

/**
 * 取工作区绑定的默认身份 Profile；无绑定时：
 *  - 老库已有全局 web-default 且**尚未被别的工作区绑走** → 绑定它（兼容升级，数据不丢）；
 *    已被绑走则创建本工作区专属 Profile——否则第二个用户会共享第一个用户的身份（隔离破洞）。
 *  - 否则创建 workspace 专属默认 Profile 并绑定。
 * 身份/记忆/对话由此实现按工作区（即按用户）隔离。
 */
export function ensureWorkspaceProfile(db: DatabaseType | undefined, workspaceId: string): string {
  const d = db ?? getDatabase();
  const binding = getBindingsForWorkspace(d, workspaceId)[0];
  if (binding && getAgentProfile(d, binding.profileId)) return binding.profileId;

  const legacy = getAgentProfile(d, 'web-default');
  const legacyTaken = d
    .prepare('SELECT 1 FROM workspace_agent_profiles WHERE profile_id = ? AND workspace_id != ?')
    .get('web-default', workspaceId);
  if (legacy && !legacyTaken) {
    bindProfileToWorkspace(d, workspaceId, 'web-default');
    return 'web-default';
  }
  const id = `ws-${workspaceId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}-default`;
  if (!getAgentProfile(d, id)) {
    createAgentProfile(d, {
      id,
      name: '养殖场健康管理助手',
      identityPrompt: '你是养殖场健康管理数字员工，负责辅助员工查询猪舍指标、记录现场观察、检索养殖规范并跟进复检任务。你不替代兽医做诊断或开药。',
      agentsPrompt: '先确认猪舍和批次，再查询指标；发现异常时给出依据、风险等级和下一步检查建议；涉及创建任务时调用工具并等待负责人确认。',
      toolsPrompt: '可用工具：query_pen_metrics、query_operation_sop、record_health_observation、create_inspection_task、recall、remember。',
    });
  }
  bindProfileToWorkspace(d, workspaceId, id);
  return id;
}

// ── 初始化断言（迁移后验证） ──────────────────────────────────────────

export function assertProductModelSchema(db: DatabaseType): void {
  assertSchema(db, 'agent_profiles', ['id', 'name', 'identity_hash', 'version'], []);
  assertSchema(db, 'workspaces', ['id', 'name', 'folder'], []);
  assertSchema(db, 'workspace_agent_profiles', ['workspace_id', 'profile_id'], []);
  assertSchema(db, 'workspace_runtime_sessions', ['id', 'workspace_id', 'profile_id', 'session_key'], []);
  assertSchema(db, 'agent_profile_prompt_versions', ['profile_id', 'version', 'identity_hash', 'snapshot'], []);
}

function rowToWorkspaceMember(row: Record<string, unknown>): WorkspaceMember {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    userId: row.user_id as string,
    username: (row.username as string) ?? '',
    displayName: (row.display_name as string) ?? '',
    role: row.role as WorkspaceRole,
    createdAt: row.created_at as string,
  };
}
