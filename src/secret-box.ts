/**
 * 凭据保险箱：AES-256-GCM 加密落盘（渠道凭据等敏感配置的静态加密）。
 *  - 密钥自举：CHANNEL_ENCRYPTION_KEY env（≥16 字符）优先；缺省从会话 secret
 *    派生（sha256(secret ‖ 'channel-storage-v1')）——单文件部署不引入第二份密钥管理。
 *  - 密文格式 `iv.tag.ciphertext`（hex）：每次加密随机 IV，认证标签防篡改；
 *    解密失败一律抛错（fail-closed），绝不把坏数据当凭据用。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

let cachedKey: Buffer | null = null;

/** 测试辅助：清空密钥缓存（改 env 后需重读） */
export function resetSecretKeyCache(): void {
  cachedKey = null;
}

function storageKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env.CHANNEL_ENCRYPTION_KEY;
  const base =
    env && env.trim().length >= 16 ? env.trim() : readSessionSecretBase();
  cachedKey = crypto.createHash('sha256').update(`${base}::channel-storage-v1`, 'utf8').digest();
  return cachedKey;
}

function readSessionSecretBase(): string {
  const envSession = process.env.WEB_SESSION_SECRET;
  if (envSession && envSession.trim().length >= 16) return envSession.trim();
  try {
    const file = fs.readFileSync(path.join(DATA_DIR, 'web-session-secret'), 'utf8').trim();
    if (file.length >= 32) return file;
  } catch {
    /* 首次启动尚无会话密钥文件 */
  }
  // 兜底：生成一份（与会话密钥文件同源策略，保证可用性）
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'web-session-secret'), generated + '\n', { mode: 0o600 });
  return generated;
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', storageKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${ct.toString('hex')}`;
}

export function decryptJson<T>(payload: string): T {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('凭据密文格式非法');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', storageKey(), Buffer.from(parts[0], 'hex'));
    decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
    const pt = Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  } catch {
    throw new Error('凭据解密失败（密钥变更或数据损坏）');
  }
}
