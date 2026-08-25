/**
 * 认证模块（R21-lite）。
 *
 * 设计要点（对照原版认证思想，收窄为单机自托管场景）：
 *  - 密码：node:crypto scrypt（N=16384,r=8,p=1，64 字节派生）——内存硬度抗 GPU，
 *    零第三方依赖；格式 `scrypt$N$r$p$salt$hash` 自描述可升级。
 *    登录对"不存在的用户"也跑一遍完整 scrypt 再返回失败——抹平时序差。
 *  - 会话：库内只存 randomBytes(32) 的 token 明文本体（泄露库 ≠ 拿到可用登录态，
 *    因为 cookie 携带的是 token.HMAC-SHA256(token, secret)，伪造/重放先撞 HMAC）；
 *    校验用 timingSafeEqual 防时序攻击；30 天过期，惰性清扫。
 *  - secret 自举：WEB_SESSION_SECRET env 优先；缺省生成写入 data/web-session-secret
 *    （0600，gitignore 内）——重启不掉线、配置自包含。
 *  - 限流：登录/注册内存滑动窗（每 IP 每分钟），抗撞库的第一道闸。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as DatabaseType } from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'miniclaw_session';

// ── 密码：scrypt ──────────────────────────────────────────────────────

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** 校验密码；格式不认识的存量哈希直接失败（不抛错） */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ── 会话 secret 自举 ──────────────────────────────────────────────────

let cachedSecret: Buffer | null = null;

export function getSessionSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const env = process.env.WEB_SESSION_SECRET;
  if (env && env.trim().length >= 16) {
    cachedSecret = crypto.createHash('sha256').update(env, 'utf8').digest();
    return cachedSecret;
  }
  const file = path.join(DATA_DIR, 'web-session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) {
      cachedSecret = Buffer.from(existing, 'hex');
      return cachedSecret;
    }
  } catch {
    /* 不存在则生成 */
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, generated + '\n', { mode: 0o600 });
  cachedSecret = Buffer.from(generated, 'hex');
  return cachedSecret;
}

/** cookie 值 = token.HMAC-SHA256(token, secret) */
export function issueCookieValue(token: string): string {
  const mac = crypto.createHmac('sha256', getSessionSecret()).update(token).digest('hex');
  return `${token}.${mac}`;
}

/** 校验并拆出 token；HMAC 不匹配（伪造/篡改）返回 null */
export function verifyCookieValue(cookieValue: string | undefined): string | null {
  if (!cookieValue) return null;
  const idx = cookieValue.lastIndexOf('.');
  if (idx <= 0) return null;
  const token = cookieValue.slice(0, idx);
  const mac = cookieValue.slice(idx + 1);
  const expected = crypto.createHmac('sha256', getSessionSecret()).update(token).digest('hex');
  const a = Buffer.from(mac, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return token;
}

// ── 用户与会话（users / web_sessions 表访问） ─────────────────────────

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
}

export interface WebSessionContext {
  user: AuthUser;
  workspaceId: string | null;
}

function rowToUser(row: Record<string, unknown>): AuthUser {
  return {
    id: row.id as string,
    username: row.username as string,
    displayName: (row.display_name as string) || '',
    createdAt: row.created_at as string,
  };
}

export function countUsers(db: DatabaseType): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

export function getUserByUsername(db: DatabaseType, username: string): AuthUser & { passwordHash: string } | null {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return { ...rowToUser(row), passwordHash: row.password_hash as string };
}

export function getUserById(db: DatabaseType, id: string): AuthUser | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

export function createUser(
  db: DatabaseType,
  input: { username: string; password: string; displayName?: string },
): AuthUser {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO users (id, username, password_hash, display_name) VALUES (?, ?, ?, ?)',
  ).run(id, input.username.trim(), hashPassword(input.password), input.displayName?.trim() ?? '');
  return getUserById(db, id)!;
}

/**
 * 验证登录：无论用户是否存在都执行一次完整 scrypt——恒定时间语义防用户枚举。
 * 返回用户或 null（不可区分"密码错"与"用户不存在"）。
 */
export function authenticate(db: DatabaseType, username: string, password: string): AuthUser | null {
  const user = getUserByUsername(db, username);
  const stored = user?.passwordHash ?? hashPassword(crypto.randomBytes(16).toString('hex'));
  const ok = verifyPassword(password, stored);
  return ok && user ? user : null;
}

export function createWebSession(
  db: DatabaseType,
  userId: string,
  workspaceId?: string,
): { token: string; expiresAt: string } {
  sweepExpiredSessions(db);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO web_sessions (token, user_id, expires_at, workspace_id) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    expiresAt,
    workspaceId ?? null,
  );
  return { token, expiresAt };
}

export function getSessionUser(db: DatabaseType, token: string): AuthUser | null {
  return getSessionContext(db, token)?.user ?? null;
}

export function getSessionContext(db: DatabaseType, token: string): WebSessionContext | null {
  const row = db
    .prepare(
      `SELECT u.*, s.workspace_id FROM web_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, new Date().toISOString()) as Record<string, unknown> | undefined;
  if (!row) return null;
  let workspaceId = (row.workspace_id as string | null) ?? null;
  if (workspaceId) {
    const member = db.prepare(
      'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    ).get(workspaceId, row.id as string);
    if (!member) workspaceId = null;
  }
  return { user: rowToUser(row), workspaceId };
}

export function setSessionWorkspace(db: DatabaseType, token: string, workspaceId: string): boolean {
  const context = getSessionContext(db, token);
  if (!context) return false;
  const member = db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
  ).get(workspaceId, context.user.id);
  if (!member) return false;
  const result = db.prepare(
    'UPDATE web_sessions SET workspace_id = ? WHERE token = ? AND expires_at > ?',
  ).run(workspaceId, token, new Date().toISOString());
  return result.changes === 1;
}

export function deleteWebSession(db: DatabaseType, token: string): void {
  db.prepare('DELETE FROM web_sessions WHERE token = ?').run(token);
}

function sweepExpiredSessions(db: DatabaseType): void {
  db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

// ── 登录限流（内存滑动窗） ────────────────────────────────────────────

const attempts = new Map<string, number[]>();

/** 每 key 每 windowMs 最多 limit 次；超出返回 false */
export function checkRateLimit(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const list = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    attempts.set(key, list);
    return false;
  }
  list.push(now);
  attempts.set(key, list);
  return true;
}

export function resetRateLimits(): void {
  attempts.clear();
}
