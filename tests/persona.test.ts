/**
 * persona.ts 桥接集成测试（无需 API key）。
 *
 * 验证：Profile 四段字段 → buildPersonaPrompt 产出按固定顺序拼装的身份，
 * 且 version / identityHash 随身份编辑正确传播。
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/core/database.js';
import { createAgentProfile, updateAgentProfile } from '../src/core/models.js';
import { buildPersonaPrompt } from '../src/agent/persona.js';

function freshDb() {
  const db = new Database(':memory:');
  initDatabase(db);
  return db;
}

describe('集成 · buildPersonaPrompt', () => {
  it('四段按 IDENTITY→AGENTS 固定顺序拼装，且带版本与哈希', () => {
    const db = freshDb();
    createAgentProfile(db, {
      id: 'p1', name: '测试猫',
      identityPrompt: '你是一只海盗猫',
      agentsPrompt: '句尾带呀哈',
    });
    const persona = buildPersonaPrompt(db, 'p1');
    expect(persona.fullPrompt).toContain('## IDENTITY');
    expect(persona.fullPrompt).toContain('## AGENTS');
    expect(persona.fullPrompt.indexOf('IDENTITY')).toBeLessThan(persona.fullPrompt.indexOf('AGENTS'));
    expect(persona.version).toBe(1);
    expect(persona.identityHash).toHaveLength(64); // sha256 hex
    expect(persona.planHash).toHaveLength(64);
    expect(persona.error).toBe(false);
    db.close();
  });

  it('身份编辑后 version+1、identityHash 变化、拼装内容更新', () => {
    const db = freshDb();
    createAgentProfile(db, { id: 'p2', name: '旧', identityPrompt: '旧身份', agentsPrompt: '旧行为' });
    const before = buildPersonaPrompt(db, 'p2');
    updateAgentProfile(db, 'p2', { identityPrompt: '新身份', agentsPrompt: '新行为' });
    const after = buildPersonaPrompt(db, 'p2');
    expect(after.version).toBe(before.version + 1);
    expect(after.identityHash).not.toBe(before.identityHash);
    expect(after.fullPrompt).toContain('新身份');
    expect(after.fullPrompt).not.toContain('旧身份');
    db.close();
  });

  it('profile 不存在时 fail-fast 抛错（不静默用错误身份）', () => {
    const db = freshDb();
    expect(() => buildPersonaPrompt(db, '不存在的-id')).toThrow('无法装配身份');
    db.close();
  });
});