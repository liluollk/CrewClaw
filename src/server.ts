/**
 * Hono 应用工厂：对话端点 + 身份管理端点 + 前端静态托管。
 *
 * 设计要点：
 *  - createApp({ db }) 可注入数据库，测试直接 app.fetch()，无需起端口。
 *  - 身份管理只有一条写路径：PUT /api/persona → updateAgentProfile
 *    （重算 identity_hash → version+1 → 写不可变快照），前端不绕过管线直改库。
 *  - 校验复用 prompt.ts 的 validateSegments（必填段 + 每段 20K 上限），
 *    非法输入 400 返回中文错误，不落库。
 *  - runtime 按 persona.version 缓存：身份一变，下一回合自动重建生效。
 *  - 静态托管 web/dist（React 构建产物），未构建时返回指引页而非 404。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Database as DatabaseType } from 'better-sqlite3';
import { getDatabase } from './database.js';
import {
  createAgentProfile,
  appendChatMessage,
  createWorkspace,
  ensureUserWorkspace,
  ensureWorkspaceProfile,
  getAgentProfile,
  getWorkspace,
  getWorkspaceMembership,
  listWorkspaceMembers,
  addWorkspaceMember,
  bindProfileToWorkspace,
  getBindingsForWorkspace,
  listChatMessages,
  updateAgentProfile,
  getPromptVersionSnapshots,
} from './models.js';
import { validateSegments } from './prompt.js';
import { buildPersonaPrompt } from './persona.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PROJECT_ROOT } from './agent-runtime.js';
import {
  createPiRuntime,
  createAgentFactory,
  runTurn,
  streamTurn,
  type AgentRuntimeOptions,
} from './agent-runtime.js';
import {
  MEMORY_KINDS,
  createMemory,
  forgetMemory,
  listMemoryVersions,
  listRecallable,
  searchMemory,
  updateMemory,
  RevisionConflictError,
  IdempotencyConflictError,
  type MemoryKind,
} from './memory.js';
import { createMemoryTools } from './memory-tools.js';
import { permissionLoop } from './permission-loop.js';
import { allTools } from './tools.js';
import { buildSessionKey, parseSessionKey } from './channel.js';
import { turnContext } from './runtime-context.js';
import { decryptJson, encryptJson } from './secret-box.js';
import {
  getProviderConfig,
  saveProviderConfig,
  probeProvider,
  ProviderConfigError,
  getAccessConfig,
  saveAccessConfig,
  PLAN_PROVIDERS,
} from './provider-config.js';
import crypto from 'node:crypto';
import { Scheduler, describeSchedule, parseSchedule, nextRunFrom, type ScheduledTaskRow } from './scheduler.js';
import { runSerial } from './serial.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  authenticate,
  checkRateLimit,
  createWebSession,
  createUser,
  countUsers,
  deleteWebSession,
  getSessionUser,
  getSessionContext,
  setSessionWorkspace,
  getUserByUsername,
  issueCookieValue,
  verifyCookieValue,
  type AuthUser,
} from './auth.js';

/** Web 工作台默认身份 Profile（遗留全局身份；多用户后每个工作区绑定自己的 Profile） */
export const DEFAULT_PROFILE_ID = 'web-default';
/** 网关 env 渠道使用的系统工作区（二期由 workspace_channels 取代） */
export const DEFAULT_WORKSPACE_ID = 'ws-web';

/** Web 会话键（按工作区隔离）：渠道+账号=工作区+对话 */
export function webSessionKeyFor(workspaceId: string): string {
  return buildSessionKey({ kind: 'web', accountId: workspaceId, conversationId: 'default' });
}

/** 遗留常量：单用户时代的 Web 会话键，仅兼容旧测试引用 */
export const WEB_SESSION_KEY = buildSessionKey({ kind: 'web', conversationId: 'default' });

type Env = { Variables: { authUser: AuthUser; workspaceId: string; profileId: string; sessionKey: string; workspaceRole: string } };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'web', 'dist');
const AGENT_DIR = path.join(ROOT, 'agent');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 默认身份落库（幂等）：demo/遗留路径共用；多用户下工作区身份走 ensureWorkspaceProfile */
export function ensureDefaultProfile(db: DatabaseType, id: string = DEFAULT_PROFILE_ID): void {
  if (getAgentProfile(db, id)) return;
  createAgentProfile(db, {
    id,
    name: '养殖场健康管理助手',
    identityPrompt: '你是养殖场健康管理数字员工，负责辅助员工查询猪舍指标、记录现场观察、检索养殖规范并跟进复检任务。你不替代兽医做诊断或开药。',
    agentsPrompt: '先确认猪舍和批次，再查询指标；发现异常时给出依据、风险等级和下一步检查建议；涉及创建任务时调用工具并等待负责人确认。',
    toolsPrompt: '可用工具：query_pen_metrics、query_operation_sop、record_health_observation、create_inspection_task、recall、remember。',
  });
}

function personaJson(db: DatabaseType, id: string) {
  const p = getAgentProfile(db, id);
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    identityHash: p.identityHash,
    updatedAt: p.updatedAt,
    segments: {
      identity: p.identityPrompt,
      soul: p.soulPrompt,
      agents: p.agentsPrompt,
      tools: p.toolsPrompt,
    },
  };
}

export interface AppOptions {
  db?: DatabaseType;
  /** 身份变更后的回调（index.ts 用它通知网关重建会话） */
  onPersonaChanged?: (version: number) => void;
  /** 渠道凭据变更后的回调（网关重挂载） */
  onChannelsChanged?: () => void;
  /** 关闭认证（仅测试便利；生产恒开） */
  authDisabled?: boolean;
  /** 注入回合执行（测试用）：替换真实 Pi 调用 */
  executeTurn?: (input: { workspaceId: string; prompt: string; sessionKey: string }) => Promise<string>;
}

export function createApp(opts: AppOptions = {}) {
  const app = new Hono<Env>();
  const db = () => opts.db ?? getDatabase();

  // ── 认证（R21-lite）：/api/auth/* 豁免，其余 /api/* 一律要求登录 ────

  const AUTH_EXEMPT = new Set(['/api/auth/register', '/api/auth/login']);

  function cookieToken(c: Context): string | null {
    const cookieHeader = c.req.header('Cookie') ?? '';
    const raw = cookieHeader
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    return verifyCookieValue(raw ? decodeURIComponent(raw) : undefined);
  }

  const canManageWorkspace = (c: Context): boolean =>
    c.get('workspaceRole') === 'owner' || c.get('workspaceRole') === 'admin';

  const requireWorkspaceManager = (c: Context): Response | null =>
    canManageWorkspace(c) ? null : c.json({ error: '需要管理员权限' }, 403);

  app.use('/api/*', async (c, next) => {
    if (opts.authDisabled || AUTH_EXEMPT.has(c.req.path)) return next();
    const token = cookieToken(c);
    const session = token ? getSessionContext(db(), token) : null;
    const user = session?.user ?? null;
    if (!user) return c.json({ error: '未登录' }, 401);
    const selected = session?.workspaceId ? getWorkspace(db(), session.workspaceId) : null;
    const workspace = selected ?? ensureUserWorkspace(db(), user);
    if (token && session?.workspaceId !== workspace.id) setSessionWorkspace(db(), token, workspace.id);
    const membership = getWorkspaceMembership(db(), workspace.id, user.id);
    if (!membership) return c.json({ error: '无权访问该工作区' }, 403);
    c.set('authUser', user);
    c.set('workspaceId', workspace.id);
    c.set('profileId', ensureWorkspaceProfile(db(), workspace.id));
    c.set('sessionKey', webSessionKeyFor(workspace.id));
    c.set('workspaceRole', membership.role);
    await next();
  });

  // ── 认证路由 ────────────────────────────────────────────────────────

  const clientKey = (c: Context) => {
    const xf = c.req.header('X-Forwarded-For');
    return xf?.split(',')[0]?.trim() || 'local';
  };

  app.post('/api/auth/register', async (c) => {
    if (!checkRateLimit(`reg:${clientKey(c)}`, 5)) {
      return c.json({ error: '注册过于频繁，稍后再试' }, 429);
    }
    if (countUsers(db()) > 0 && process.env.ALLOW_REGISTER === '0') {
      return c.json({ error: '注册已关闭' }, 403);
    }
    const body = await c.req.json().catch(() => null);
    const username = (body?.username ?? '').toString().trim();
    const password = (body?.password ?? '').toString();
    const displayName = (body?.displayName ?? '').toString();
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(username)) {
      return c.json({ error: '用户名需 2-32 位字母/数字/下划线/中划线' }, 400);
    }
    if (password.length < 8) return c.json({ error: '密码至少 8 位' }, 400);
    if (getUserByUsername(db(), username)) return c.json({ error: '用户名已存在' }, 409);
    const user = createUser(db(), { username, password, displayName: displayName || username });
    const workspace = ensureUserWorkspace(db(), user); // 首个用户自动接管存量工作区
    const { token } = createWebSession(db(), user.id, workspace.id);
    return c.json(
      { user: { id: user.id, username: user.username, displayName: user.displayName } },
      200,
      {
        'Set-Cookie': sessionCookie(c, issueCookieValue(token)),
      },
    );
  });

  app.post('/api/auth/login', async (c) => {
    const ipKey = `login:${clientKey(c)}`;
    if (!checkRateLimit(ipKey, 10)) {
      return c.json({ error: '尝试过于频繁，稍后再试' }, 429);
    }
    const body = await c.req.json().catch(() => null);
    const username = (body?.username ?? '').toString().trim();
    const password = (body?.password ?? '').toString();
    if (!checkRateLimit(`login-u:${username}`, 5)) {
      return c.json({ error: '该账号尝试过于频繁，稍后再试' }, 429);
    }
    // 不存在的用户也跑完整 scrypt——恒定时间语义，不可枚举用户
    const user = authenticate(db(), username, password);
    if (!user) return c.json({ error: '用户名或密码错误' }, 401);
    const workspace = ensureUserWorkspace(db(), user);
    const { token } = createWebSession(db(), user.id, workspace.id);
    return c.json(
      { user: { id: user.id, username: user.username, displayName: user.displayName } },
      200,
      { 'Set-Cookie': sessionCookie(c, issueCookieValue(token)) },
    );
  });

  app.post('/api/auth/logout', (c) => {
    const cookieHeader = c.req.header('Cookie') ?? '';
    const raw = cookieHeader
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    const token = verifyCookieValue(raw ? decodeURIComponent(raw) : undefined);
    if (token) deleteWebSession(db(), token);
    return c.json({ ok: true }, 200, {
      'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    });
  });

  app.get('/api/auth/me', (c) => {
    const user = c.get('authUser');
    return c.json({
      user: { id: user.id, username: user.username, displayName: user.displayName },
      workspaceId: c.get('workspaceId'),
      profileId: c.get('profileId'),
      role: c.get('workspaceRole'),
    });
  });

  // ── Workspace 成员与切换 ────────────────────────────────────────────

  app.get('/api/workspaces', (c) => {
    const rows = db().prepare(`
      SELECT w.id, w.name, w.folder, wm.role,
             CASE WHEN w.id = ? THEN 1 ELSE 0 END AS active
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ?
      ORDER BY active DESC, w.created_at
    `).all(c.get('workspaceId'), c.get('authUser').id) as Array<Record<string, unknown>>;
    return c.json(rows.map((r) => ({
      id: r.id,
      name: r.name,
      folder: r.folder,
      role: r.role,
      active: !!r.active,
    })));
  });

  app.post('/api/workspaces/:id/select', (c) => {
    const token = cookieToken(c);
    if (!token || !setSessionWorkspace(db(), token, c.req.param('id'))) {
      return c.json({ error: '无权访问该工作区' }, 403);
    }
    return c.json({ ok: true, workspaceId: c.req.param('id') });
  });

  app.get('/api/workspace/members', (c) => {
    return c.json(listWorkspaceMembers(db(), c.get('workspaceId')));
  });

  app.post('/api/workspace/members', async (c) => {
    if (!canManageWorkspace(c)) return c.json({ error: '需要管理员权限' }, 403);
    const body = await c.req.json().catch(() => null);
    const username = (body?.username ?? '').toString().trim();
    const role = (body?.role ?? 'member').toString();
    if (!username) return c.json({ error: 'username 必填' }, 400);
    if (!['admin', 'member'].includes(role)) return c.json({ error: '只能添加 admin 或 member' }, 400);
    const user = getUserByUsername(db(), username);
    if (!user) return c.json({ error: '用户不存在' }, 404);
    try {
      const member = addWorkspaceMember(db(), {
        workspaceId: c.get('workspaceId'),
        userId: user.id,
        role: role as 'admin' | 'member',
      });
      return c.json(member, 201);
    } catch (e) {
      if (String(e).includes('UNIQUE constraint')) return c.json({ error: '用户已经是该工作区成员' }, 409);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.patch('/api/workspace/members/:userId', async (c) => {
    if (!canManageWorkspace(c)) return c.json({ error: '需要管理员权限' }, 403);
    const role = ((await c.req.json().catch(() => null))?.role ?? '').toString();
    if (!['admin', 'member'].includes(role)) return c.json({ error: 'role 只能是 admin 或 member' }, 400);
    const workspaceId = c.get('workspaceId');
    const userId = c.req.param('userId');
    const target = getWorkspaceMembership(db(), workspaceId, userId);
    if (!target) return c.json({ error: '成员不存在' }, 404);
    if (target.role === 'owner') return c.json({ error: '不能修改 Workspace owner' }, 400);
    db().prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?')
      .run(role, workspaceId, userId);
    return c.json(getWorkspaceMembership(db(), workspaceId, userId));
  });

  app.delete('/api/workspace/members/:userId', (c) => {
    if (!canManageWorkspace(c)) return c.json({ error: '需要管理员权限' }, 403);
    const workspaceId = c.get('workspaceId');
    const userId = c.req.param('userId');
    const target = getWorkspaceMembership(db(), workspaceId, userId);
    if (!target) return c.json({ error: '成员不存在' }, 404);
    if (target.role === 'owner') return c.json({ error: '不能移除 Workspace owner' }, 400);
    db().prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, userId);
    return c.json({ ok: true });
  });

  // ── 工作区 Agent 注册表 ────────────────────────────────────────────

  app.get('/api/agents', (c) => {
    return c.json(
      getBindingsForWorkspace(db(), c.get('workspaceId')).flatMap((binding) => {
        const profile = getAgentProfile(db(), binding.profileId);
        if (!profile) return [];
        return [{
          id: profile.id,
          name: profile.name,
          version: profile.version,
          interactionMode: binding.interactionMode,
          identityHash: profile.identityHash,
        }];
      }),
    );
  });

  app.post('/api/agents', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const name = (body?.name ?? '').toString().trim();
    if (!name) return c.json({ error: 'Agent 名称必填' }, 400);
    if (name.length > 80) return c.json({ error: 'Agent 名称不能超过 80 个字符' }, 400);
    const id = `agent-${crypto.randomUUID()}`;
    const profile = createAgentProfile(db(), {
      id,
      name,
      identityPrompt: typeof body.identityPrompt === 'string' ? body.identityPrompt : undefined,
      soulPrompt: typeof body.soulPrompt === 'string' ? body.soulPrompt : undefined,
      agentsPrompt: typeof body.agentsPrompt === 'string' ? body.agentsPrompt : undefined,
      toolsPrompt: typeof body.toolsPrompt === 'string' ? body.toolsPrompt : undefined,
    });
    const binding = bindProfileToWorkspace(db(), c.get('workspaceId'), profile.id,
      typeof body.interactionMode === 'string' ? body.interactionMode : 'chat');
    return c.json({
      id: profile.id,
      name: profile.name,
      version: profile.version,
      interactionMode: binding.interactionMode,
      identityHash: profile.identityHash,
    }, 201);
  });

  app.delete('/api/agents/:id', (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const workspaceId = c.get('workspaceId');
    const profileId = c.req.param('id');
    const bindings = getBindingsForWorkspace(db(), workspaceId);
    if (!bindings.some((b) => b.profileId === profileId)) return c.json({ error: 'Agent 不存在' }, 404);
    if (bindings.length <= 1) return c.json({ error: '工作区至少保留一个 Agent' }, 400);
    db().prepare('DELETE FROM workspace_agent_profiles WHERE workspace_id = ? AND profile_id = ?').run(workspaceId, profileId);
    return c.json({ ok: true });
  });

  /** 会话 cookie：HttpOnly + SameSite=Strict + 30 天；https 下追加 Secure */
  function sessionCookie(c: Context, value: string): string {
    const secure = c.req.url.startsWith('https') ? '; Secure' : '';
    return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
  }

  // ── 身份管理（按当前工作区绑定的 Profile） ──────────────────────────

  app.get('/api/persona', (c) => {
    const json = personaJson(db(), c.get('profileId'));
    return json ? c.json(json) : c.json({ error: 'Profile 不存在' }, 404);
  });

  app.put('/api/persona', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const profileId = c.get('profileId');
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: '需要 JSON 请求体' }, 400);
    const existing = getAgentProfile(db(), profileId);
    if (!existing) return c.json({ error: 'Profile 不存在' }, 404);

    const pick = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
    const merged = {
      name: pick(body.name, existing.name),
      identity: pick(body.identityPrompt, existing.identityPrompt),
      soul: pick(body.soulPrompt, existing.soulPrompt),
      agents: pick(body.agentsPrompt, existing.agentsPrompt),
      tools: pick(body.toolsPrompt, existing.toolsPrompt),
    };
    const errors = validateSegments({
      identity: merged.identity,
      soul: merged.soul,
      agents: merged.agents,
      tools: merged.tools,
    });
    if (errors.length > 0) return c.json({ error: errors.join('；') }, 400);

    updateAgentProfile(db(), profileId, {
      name: merged.name,
      identityPrompt: merged.identity,
      soulPrompt: merged.soul,
      agentsPrompt: merged.agents,
      toolsPrompt: merged.tools,
    });
    opts.onPersonaChanged?.(getAgentProfile(db(), profileId)?.version ?? 0);
    return c.json(personaJson(db(), profileId));
  });

  app.get('/api/persona/versions', (c) => {
    const rows = getPromptVersionSnapshots(db(), c.get('profileId'));
    return c.json(
      rows.map((r) => {
        let snapshot: unknown = null;
        try {
          snapshot = JSON.parse(r.snapshot);
        } catch {
          /* 快照解析失败不阻塞列表 */
        }
        return { version: r.version, identityHash: r.identityHash, createdAt: r.createdAt, snapshot };
      }),
    );
  });

  // ── Workspace 记忆（默认 workspace 分区） ────────────────────────────

  /** 统一错误映射：CAS 冲突 409（回传 currentRevision）、幂等冲突 409、不存在 404、非法 400 */
  function memoryError(c: Context, e: unknown): Response {
    if (e instanceof RevisionConflictError) {
      return c.json({ error: e.message, currentRevision: e.currentRevision }, 409);
    }
    if (e instanceof IdempotencyConflictError) {
      return c.json({ error: e.message, existingItemId: e.existingItemId }, 409);
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('非法知识类型')) return c.json({ error: msg }, 400);
    if (msg.includes('记忆不存在')) return c.json({ error: msg }, 404);
    return c.json({ error: msg }, 500);
  }

  app.get('/api/memory', (c) => {
    const q = c.req.query('q')?.trim() ?? '';
    const limit = Math.min(Number(c.req.query('limit')) || 20, 100);
    const ws = c.get('workspaceId');
    const items = q
      ? searchMemory(db(), { workspaceId: ws, query: q, limit })
      : listRecallable(db(), { workspaceId: ws, limit });
    return c.json(items);
  });

  app.post('/api/memory', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
      return c.json({ error: 'content 必填' }, 400);
    }
    if (!MEMORY_KINDS.includes(body.kind)) {
      return c.json({ error: `kind 必须是 ${MEMORY_KINDS.join('/')}` }, 400);
    }
    try {
      const { item, replayed } = createMemory(db(), {
        workspaceId: c.get('workspaceId'),
        kind: body.kind as MemoryKind,
        content: body.content,
        title: typeof body.title === 'string' ? body.title : undefined,
        importance: typeof body.importance === 'number' ? body.importance : undefined,
        scope: body.scope === 'conversation' ? 'conversation' : 'workspace',
        scopeKey: typeof body.scopeKey === 'string' ? body.scopeKey : undefined,
        idempotencyKey:
          typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      });
      return c.json({ item, replayed }, 201);
    } catch (e) {
      return memoryError(c, e);
    }
  });

  app.put('/api/memory/:id', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.content !== 'string' || typeof body.expectedRevision !== 'number') {
      return c.json({ error: '需要 content 与 expectedRevision' }, 400);
    }
    try {
      const item = updateMemory(db(), {
        itemId: c.req.param('id'),
        expectedRevision: body.expectedRevision,
        content: body.content,
        title: typeof body.title === 'string' ? body.title : undefined,
        workspaceId: c.get('workspaceId'),
      });
      return c.json(item);
    } catch (e) {
      return memoryError(c, e);
    }
  });

  app.delete('/api/memory/:id', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.expectedRevision !== 'number') {
      return c.json({ error: '需要 expectedRevision' }, 400);
    }
    try {
      forgetMemory(db(), {
        itemId: c.req.param('id'),
        expectedRevision: body.expectedRevision,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        workspaceId: c.get('workspaceId'),
      });
      return c.json({ ok: true });
    } catch (e) {
      return memoryError(c, e);
    }
  });

  app.get('/api/memory/:id/versions', (c) => {
    const rows = listMemoryVersions(db(), c.req.param('id'), c.get('workspaceId'));
    return c.json(
      rows.map((r) => {
        let snapshot: unknown = null;
        try {
          snapshot = JSON.parse(r.snapshot);
        } catch {
          /* 快照解析失败不阻塞列表 */
        }
        return { revision: r.revision, changeType: r.changeType, createdAt: r.createdAt, snapshot };
      }),
    );
  });

  // ── 复合会话键寻址（build/parse 往返演示） ───────────────────────────

  app.get('/api/session-key', (c) => {
    const kind = c.req.query('kind') ?? '';
    const conv = c.req.query('conv') ?? '';
    const account = c.req.query('account') || undefined;
    const thread = c.req.query('thread') || undefined;
    try {
      const key = buildSessionKey({ kind, accountId: account, conversationId: conv, threadId: thread });
      return c.json({ key, parts: parseSessionKey(key) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.get('/api/session-key/parse', (c) => {
    const key = c.req.query('key') ?? '';
    try {
      return c.json({ parts: parseSessionKey(key) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // ── 对话（runtime 按工作区懒初始化，身份版本或接入方式变更即重建；业务工具 + 记忆工具） ──

  const runtimes = new Map<string, { promise: ReturnType<typeof createPiRuntime>; version: number; accessVersion: number }>();
  function getRuntime(wsId: string, profId: string) {
    const persona = buildPersonaPrompt(db(), profId);
    const access = getAccessConfig(db());
    const cached = runtimes.get(wsId);
    if (cached && cached.version === persona.version && cached.accessVersion === access.version) {
      return cached.promise;
    }
    const rt: AgentRuntimeOptions =
      access.mode === 'plan'
        ? {
            planModel: { providerId: access.plan, modelId: access.model },
            // 会话目录按工作区隔离：不同用户的对话各存各的
            sessionName: `ws-${wsId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`,
            systemPrompt: persona.fullPrompt,
            customTools: [...allTools, ...createMemoryTools(wsId)],
          }
        : (() => {
            const provider = getProviderConfig(db(), AGENT_DIR);
            return {
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              modelId: provider.modelId,
              providerId: provider.providerId,
              sessionName: `ws-${wsId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`,
              systemPrompt: persona.fullPrompt,
              customTools: [...allTools, ...createMemoryTools(wsId)],
            } satisfies AgentRuntimeOptions;
          })();
    const promise = createPiRuntime(rt);
    runtimes.set(wsId, { promise, version: persona.version, accessVersion: access.version });
    return promise;
  }

  // 同工作区回合串行：用户 SSE 对话、普通对话、定时任务共用一条车道
  // （runSerial），避免"任务正在跑、用户又发消息"并发打同一个 Pi 会话。
  function runTurnForWorkspace(
    wsId: string,
    profId: string,
    text: string,
    sessionKey: string,
    triggerType: 'message' | 'schedule' = 'message',
    actorUserId?: string,
    workspaceRole?: 'owner' | 'admin' | 'member',
  ): Promise<string> {
    return runSerial(wsId, () =>
      getRuntime(wsId, profId).then(({ session }) =>
        turnContext.run({ workspaceId: wsId, sessionKey, agentId: profId, actorUserId, workspaceRole, triggerType }, () => runTurn(session, text)),
      ),
    ).then((r) => r.text);
  }

  app.post('/api/chat', async (c) => {
    const body = await c.req.json().catch(() => null);
    const text = (body?.text ?? '').toString().trim();
    if (!text) return c.json({ error: '缺少文本' }, 400);
    const sessionKey = c.get('sessionKey');
    const wsId = c.get('workspaceId');
    permissionLoop.currentSessionKey = sessionKey;
    appendChatMessage(db(), { sessionKey, role: 'user', content: text });
    try {
      const reply = await runTurnForWorkspace(wsId, c.get('profileId'), text, sessionKey, 'message', c.get('authUser').id, c.get('workspaceRole') as 'owner' | 'admin' | 'member');
      const out = reply || '(空回复)';
      appendChatMessage(db(), { sessionKey, role: 'assistant', content: out });
      return c.json({ reply: out });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post('/api/chat/stream', async (c) => {
    const body = await c.req.json().catch(() => null);
    const text = (body?.text ?? '').toString().trim();
    if (!text) return c.json({ error: '缺少文本' }, 400);
    const wsId = c.get('workspaceId');
    const sessionKey = c.get('sessionKey');
    permissionLoop.currentSessionKey = sessionKey;
    appendChatMessage(db(), { sessionKey, role: 'user', content: text });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        // 客户端中途断开时 enqueue 会抛——吞掉即可，回合照常完成并落账
        const send = (data: unknown) => {
          try {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            /* 连接已断 */
          }
        };
        // 整个流式回合进同工作区串行队列：排队等待 → 拿 runtime → 开流，
        // onDone/onError 才算回合结束（队列因此等真实完成而非开流瞬间）。
        void runSerial(wsId, async () => {
          const { session } = await getRuntime(wsId, c.get('profileId'));
          await new Promise<void>((resolveTurn) => {
            // 写操作确认请求 → SSE 确认卡（工具在回合内触发，这里转发给前端）
            const offConfirm = permissionLoop.onRequest((a) => {
              send({ type: 'confirm_request', id: a.id, tool: a.tool, summary: a.summary, requestedBy: a.requestedBy ?? null });
            });
            const finish = () => {
              offConfirm();
              resolveTurn();
            };
            // 回合上下文：工具（记忆读写/确认登记）从这里取工作区归属
            turnContext.run({ workspaceId: wsId, sessionKey, agentId: c.get('profileId'), actorUserId: c.get('authUser').id, workspaceRole: c.get('workspaceRole') as 'owner' | 'admin' | 'member', triggerType: 'message' }, () =>
              streamTurn(session, text, {
                onDelta: (delta) => send({ type: 'delta', delta }),
                onThinkingDelta: (delta) => send({ type: 'thinking', delta }),
                onToolStart: (name, args) => send({ type: 'tool_start', name, args }),
                onToolEnd: (name) => send({ type: 'tool_end', name }),
                onDone: (full, sessionId) => {
                  const out = full || '(空回复)';
                  appendChatMessage(db(), { sessionKey, role: 'assistant', content: out });
                  send({ type: 'done', full: out, sessionId });
                  controller.close();
                  finish();
                },
                onError: (err) => {
                  appendChatMessage(db(), {
                    sessionKey,
                    role: 'system',
                    content: `本轮处理失败：${String(err)}`,
                  });
                  send({ type: 'error', message: String(err) });
                  controller.close();
                  finish();
                },
              }),
            );
          });
        });
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  // 对话历史：刷新不丢，按工作区会话键读取（跨用户天然隔离）
  app.get('/api/chat/history', (c) => {
    const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
    return c.json(listChatMessages(db(), { sessionKey: c.get('sessionKey'), limit }));
  });

  // 确认回路：用户在确认卡上点击后裁决。
  // 归属闸门：只允许裁决本工作区会话的待确认请求——别人的确认卡按 404 反枚举。
  app.post('/api/permission/confirm', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.id !== 'string' || typeof body.approve !== 'boolean') {
      return c.json({ error: '需要 id 与 approve' }, 400);
    }
    const outcome = await permissionLoop.confirm(body.id, body.approve, c.get('sessionKey'));
    if (outcome.status === 'not_found') return c.json({ error: outcome.resultText }, 404);
    if (outcome.status === 'executed' || outcome.status === 'failed') {
      // executed → 落"已执行"底账；failed → 落"执行失败"底账（可回看，且待办已放回可重试）
      appendChatMessage(db(), { sessionKey: c.get('sessionKey'), role: 'system', content: outcome.resultText });
    }
    return c.json(outcome);
  });

  // ── 模型接入（自定义接口走 Pi 原生文件；订阅套餐走 SDK OAuth 登录） ──

  /** 管理面 ModelRuntime 单例：套餐登录/登出/目录查询共用（凭据落在 agent/auth.json） */
  let managementRuntimePromise: ReturnType<typeof ModelRuntime.create> | null = null;
  function getManagementRuntime() {
    managementRuntimePromise ??= ModelRuntime.create({
      authPath: path.join(AGENT_DIR, 'auth.json'),
      modelsPath: path.join(AGENT_DIR, 'models.json'),
      refreshOnCreate: false,
    });
    return managementRuntimePromise;
  }

  interface PlanLoginSession {
    id: string;
    plan: string;
    status: 'waiting' | 'done' | 'error' | 'cancelled';
    events: Array<Record<string, unknown>>;
    prompt: Record<string, unknown> | null;
    promptResolve: ((value: string) => void) | null;
    error?: string;
    controller: AbortController;
    createdAt: number;
  }
  const planLogins = new Map<string, PlanLoginSession>();
  const PLAN_LOGIN_TTL_MS = 10 * 60_000;

  app.get('/api/provider', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const cfg = getProviderConfig(db(), AGENT_DIR);
    const access = getAccessConfig(db());
    const runtime = await getManagementRuntime();
    const plans = PLAN_PROVIDERS.map((p) => ({
      ...p,
      loggedIn: runtime.hasConfiguredAuth(p.id),
    }));
    return c.json({
      access,
      plans,
      source: cfg.source,
      baseUrl: cfg.baseUrl,
      modelId: cfg.modelId,
      apiKeyConfigured: !!cfg.apiKey,
      version: cfg.version,
    });
  });

  app.put('/api/provider', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: '需要 JSON 请求体' }, 400);
    try {
      const cfg = saveProviderConfig(db(), AGENT_DIR, {
        baseUrl: String(body.baseUrl ?? ''),
        modelId: String(body.modelId ?? ''),
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
      });
      return c.json({ ok: true, source: cfg.source, baseUrl: cfg.baseUrl, modelId: cfg.modelId, version: cfg.version });
    } catch (e) {
      if (e instanceof ProviderConfigError) return c.json({ error: e.message }, 400);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // 连通性探测：优先用表单里的值（保存前即可测试），留空则用已保存/环境变量配置
  app.post('/api/provider/test', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    const saved = getProviderConfig(db(), AGENT_DIR);
    const cfg = {
      baseUrl: typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : saved.baseUrl,
      modelId: typeof body.modelId === 'string' && body.modelId.trim() ? body.modelId.trim() : saved.modelId,
      apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : saved.apiKey,
    };
    if (!cfg.baseUrl || !cfg.modelId || !cfg.apiKey) {
      return c.json({ ok: false, status: 0, message: '接入信息不完整：baseUrl / modelId / API Key 缺一不可' });
    }
    const result = await probeProvider(cfg);
    return c.json(result);
  });

  /** 套餐登录交互桥：SDK 的 prompt()/notify() ↔ 前端轮询/应答 */
  app.post('/api/provider/plan-login', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const plan = (body?.plan ?? '').toString();
    if (!PLAN_PROVIDERS.some((p) => p.id === plan)) {
      return c.json({ error: '不支持的套餐' }, 400);
    }
    for (const [id, sess] of planLogins) {
      if (Date.now() - sess.createdAt > PLAN_LOGIN_TTL_MS) planLogins.delete(id);
    }
    const session: PlanLoginSession = {
      id: crypto.randomUUID(),
      plan,
      status: 'waiting',
      events: [],
      prompt: null,
      promptResolve: null,
      controller: new AbortController(),
      createdAt: Date.now(),
    };
    planLogins.set(session.id, session);
    const runtime = await getManagementRuntime();
    void runtime
      .login(plan, 'oauth', {
        signal: session.controller.signal,
        prompt: (p: { type: string; message: string; placeholder?: string; signal?: AbortSignal; options?: Array<{ id: string; label: string }> }) =>
          new Promise<string>((resolve, reject) => {
            session.prompt = {
              type: p.type,
              message: p.message,
              placeholder: p.placeholder,
              options: p.options,
            };
            session.promptResolve = (value) => {
              session.prompt = null;
              session.promptResolve = null;
              resolve(value);
            };
            p.signal?.addEventListener('abort', () => reject(new Error('登录已取消')));
          }),
        notify: (e: Record<string, unknown>) => {
          session.events.push({ type: String(e.type), ...e });
        },
      } as Parameters<typeof runtime.login>[2])
      .then(() => {
        session.status = 'done';
        session.controller.abort(); // 释放挂起的 prompt 等待
      })
      .catch((err: unknown) => {
        if (session.status === 'waiting') session.status = 'error';
        session.error = err instanceof Error ? err.message : String(err);
      });
    return c.json({ ok: true, loginId: session.id });
  });

  app.get('/api/provider/plan-login/:id', (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const session = planLogins.get(c.req.param('id'));
    if (!session) return c.json({ error: '登录会话不存在或已过期' }, 404);
    return c.json({
      plan: session.plan,
      status: session.status,
      events: session.events,
      prompt: session.prompt,
      error: session.error ?? null,
    });
  });

  app.post('/api/provider/plan-login/:id/prompt', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const session = planLogins.get(c.req.param('id'));
    if (!session || !session.promptResolve) return c.json({ error: '没有待应答的输入' }, 404);
    const body = await c.req.json().catch(() => null);
    const value = (body?.value ?? '').toString();
    session.promptResolve(value);
    return c.json({ ok: true });
  });

  app.post('/api/provider/plan-login/:id/cancel', (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const session = planLogins.get(c.req.param('id'));
    if (!session) return c.json({ error: '会话不存在' }, 404);
    session.status = 'cancelled';
    session.controller.abort();
    return c.json({ ok: true });
  });

  app.post('/api/provider/plan-logout', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const plan = (body?.plan ?? '').toString();
    if (!PLAN_PROVIDERS.some((p) => p.id === plan)) return c.json({ error: '不支持的套餐' }, 400);
    const runtime = await getManagementRuntime();
    await runtime.logout(plan);
    return c.json({ ok: true });
  });

  app.get('/api/provider/plan-models', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const plan = c.req.query('plan') ?? '';
    if (!PLAN_PROVIDERS.some((p) => p.id === plan)) return c.json({ error: '不支持的套餐' }, 400);
    const runtime = await getManagementRuntime();
    const models = runtime
      .getModels(plan)
      .map((m) => ({ id: m.id, name: m.name }));
    return c.json({ plan, models });
  });

  // 启用某个接入方式：套餐（需已登录且模型存在）或切回自定义接口
  app.post('/api/provider/activate', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const mode = (body?.mode ?? '').toString();
    if (mode === 'custom') {
      const access = saveAccessConfig(db(), { mode: 'custom' });
      return c.json({ ok: true, access });
    }
    if (mode === 'plan') {
      const plan = (body?.plan ?? '').toString();
      const model = (body?.model ?? '').toString();
      if (!PLAN_PROVIDERS.some((p) => p.id === plan)) return c.json({ error: '不支持的套餐' }, 400);
      const runtime = await getManagementRuntime();
      if (!runtime.getModel(plan, model)) {
        return c.json({ error: '套餐 ' + plan + ' 下不存在模型 ' + model + '（是否尚未登录？）' }, 400);
      }
      const access = saveAccessConfig(db(), { mode: 'plan', plan, model });
      return c.json({ ok: true, access });
    }
    return c.json({ error: 'mode 必须是 custom 或 plan' }, 400);
  });
  // ── 工作区渠道配置（二期：每个工作区接自己的 IM） ────────────────────

  const CHANNEL_KINDS = ['feishu', 'dingtalk'] as const;
  const REQUIRED_CREDS: Record<string, string[]> = {
    feishu: ['appId', 'appSecret'],
    dingtalk: ['clientId', 'clientSecret'],
  };

  app.get('/api/channels', (c) => {
    const rows = db()
      .prepare('SELECT * FROM workspace_channels WHERE workspace_id = ? ORDER BY kind')
      .all(c.get('workspaceId')) as Array<Record<string, unknown>>;
    // 凭据永不回传原文——只暴露"是否已配置"
    return c.json(
      rows.map((r) => ({
        kind: r.kind as string,
        accountId: (r.account_id as string) || '',
        enabled: !!(r.enabled as number),
        configured: !!(r.credentials as string),
      })),
    );
  });

  app.put('/api/channels/:kind', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const kind = c.req.param('kind');
    if (!CHANNEL_KINDS.includes(kind as (typeof CHANNEL_KINDS)[number])) {
      return c.json({ error: `不支持的渠道: ${kind}` }, 400);
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: '需要 JSON 请求体' }, 400);
    const enabled = !!body.enabled;
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    const creds = (body.credentials ?? {}) as Record<string, unknown>;

    const wsId = c.get('workspaceId');
    const existing = db()
      .prepare('SELECT * FROM workspace_channels WHERE workspace_id = ? AND kind = ?')
      .get(wsId, kind) as Record<string, unknown> | undefined;

    // 凭据更新语义：credentials 非空 → 覆盖加密重存；为空 → 保留旧密文（只改开关/账号）
    let stored = (existing?.credentials as string) ?? '';
    if (creds && Object.keys(creds).length > 0) {
      const missing = (REQUIRED_CREDS[kind] ?? []).filter(
        (k) => typeof creds[k] !== 'string' || !(creds[k] as string).trim(),
      );
      if (missing.length > 0) return c.json({ error: `缺少凭据字段: ${missing.join(', ')}` }, 400);
      stored = encryptJson(creds);
    }
    if (enabled && !stored) return c.json({ error: '尚未配置凭据，无法启用' }, 400);

    const id = `wc-${wsId.replace(/[^a-zA-Z0-9]/g, '')}-${kind}`;
    db().prepare(`
      INSERT INTO workspace_channels (id, workspace_id, kind, account_id, credentials, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (workspace_id, kind) DO UPDATE SET
        account_id = excluded.account_id, credentials = excluded.credentials,
        enabled = excluded.enabled, updated_at = datetime('now')
    `).run(id, wsId, kind, accountId, stored, enabled ? 1 : 0);
    opts.onChannelsChanged?.();
    return c.json({ ok: true, kind, enabled, configured: !!stored });
  });

  app.delete('/api/channels/:kind', (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const kind = c.req.param('kind');
    db().prepare('DELETE FROM workspace_channels WHERE workspace_id = ? AND kind = ?').run(
      c.get('workspaceId'),
      kind,
    );
    opts.onChannelsChanged?.();
    return c.json({ ok: true });
  });

  // ── 定时任务（单实例调度器；同工作区回合经串行队列执行） ────────────

  const scheduler = new Scheduler({
    db: () => db(),
    execute:
      opts.executeTurn ??
      (async ({ workspaceId, prompt, sessionKey }) => {
        const profId = ensureWorkspaceProfile(db(), workspaceId);
        return runTurnForWorkspace(workspaceId, profId, prompt, sessionKey, 'schedule');
      }),
  });
  scheduler.start();

  function taskRow(row: Record<string, unknown>) {
    let spec;
    try {
      spec = parseSchedule(row.schedule_json as string);
    } catch {
      spec = null;
    }
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      name: row.name as string,
      prompt: row.prompt as string,
      schedule: spec,
      scheduleText: spec ? describeSchedule(spec) : '（频率非法）',
      enabled: !!(row.enabled as number),
      nextRunAt: (row.next_run_at as string) ?? null,
      lastRunAt: (row.last_run_at as string) ?? null,
    };
  }

  const getTask = (id: string, wsId: string) =>
    db()
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ? AND workspace_id = ?')
      .get(id, wsId) as unknown as ScheduledTaskRow | undefined;

  app.get('/api/tasks', (c) => {
    const rows = db()
      .prepare('SELECT * FROM scheduled_tasks WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(c.get('workspaceId')) as unknown as Array<Record<string, unknown>>;
    return c.json(rows.map(taskRow));
  });

  app.post('/api/tasks', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const name = (body?.name ?? '').toString().trim();
    const prompt = (body?.prompt ?? '').toString().trim();
    if (!name) return c.json({ error: '任务名称必填' }, 400);
    if (!prompt) return c.json({ error: '任务指令必填' }, 400);
    let spec;
    try {
      spec = parseSchedule(JSON.stringify(body?.schedule ?? {}));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    const id = crypto.randomUUID();
    const next = nextRunFrom(spec, new Date());
    db().prepare(
      "INSERT INTO scheduled_tasks (id, workspace_id, name, prompt, schedule_json, enabled, next_run_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    ).run(id, c.get('workspaceId'), name, prompt, JSON.stringify(spec), next ? next.toISOString() : null);
    return c.json(taskRow(db().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as Record<string, unknown>), 201);
  });

  app.put('/api/tasks/:id', async (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const task = getTask(c.req.param('id'), c.get('workspaceId'));
    if (!task) return c.json({ error: '任务不存在' }, 404);
    const body = await c.req.json().catch(() => null) ?? {};
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : task.name;
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : task.prompt;
    let spec;
    try {
      spec = body.schedule ? parseSchedule(JSON.stringify(body.schedule)) : parseSchedule(task.schedule_json);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : !!task.enabled;
    const next = enabled ? nextRunFrom(spec, new Date()) : null;
    db().prepare(`
      UPDATE scheduled_tasks SET name = ?, prompt = ?, schedule_json = ?, enabled = ?, next_run_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, prompt, JSON.stringify(spec), enabled ? 1 : 0, next ? next.toISOString() : null, task.id);
    return c.json(taskRow(db().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(task.id) as Record<string, unknown>));
  });

  app.delete('/api/tasks/:id', (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const task = getTask(c.req.param('id'), c.get('workspaceId'));
    if (!task) return c.json({ error: '任务不存在' }, 404);
    db().prepare('DELETE FROM task_runs WHERE task_id = ?').run(task.id);
    db().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(task.id);
    return c.json({ ok: true });
  });

  app.get('/api/tasks/:id/runs', (c) => {
    const task = getTask(c.req.param('id'), c.get('workspaceId'));
    if (!task) return c.json({ error: '任务不存在' }, 404);
    const rows = db()
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 20')
      .all(task.id) as Array<Record<string, unknown>>;
    return c.json(
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        resultText: (r.result_text as string) || '',
        startedAt: r.started_at,
        finishedAt: r.finished_at ?? null,
      })),
    );
  });

  app.post('/api/tasks/:id/run', (c) => {
    const denied = requireWorkspaceManager(c);
    if (denied) return denied;
    const task = getTask(c.req.param('id'), c.get('workspaceId'));
    if (!task) return c.json({ error: '任务不存在' }, 404);
    const runId = scheduler.runNow(task);
    return c.json({ ok: true, runId });
  });

  // ── 静态托管（web/dist） ────────────────────────────────────────────

  app.get('*', (c) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith('/api/')) return c.json({ error: '接口不存在' }, 404);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const file = path.join(DIST, path.normalize(pathname));
    // 路径穿越防护：解析后必须仍在 dist 内
    if (!file.startsWith(DIST + path.sep) && file !== DIST) return c.notFound();
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file).toLowerCase();
      return new Response(fs.readFileSync(file), {
        headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' },
      });
    }
    // SPA 回退：已构建则回 index.html，未构建给指引页
    const index = path.join(DIST, 'index.html');
    if (fs.existsSync(index)) {
      return new Response(fs.readFileSync(index), {
        headers: { 'Content-Type': MIME['.html'] },
      });
    }
    return c.html(
      `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>CrewClaw · 工作台</title>` +
        `<style>body{font:15px/1.8 system-ui,sans-serif;background:#F7F7F5;color:#1A1A1A;display:grid;place-items:center;min-height:100vh;margin:0}` +
        `code{background:#fff;border:1px solid #E7E7E3;padding:2px 8px;border-radius:3px}</style></head>` +
        `<body><div style="text-align:center"><h1 style="font-size:20px">前端尚未构建</h1>` +
        `<p>运行 <code>npm run web:build</code> 后刷新本页面。</p></div></body></html>`,
    );
  });

  return app;
}
