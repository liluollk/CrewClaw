# Shared Team Workspace and Scoped Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 CrewClaw 改造成多人共享团队 Workspace，并实现团队记忆与会话记忆隔离。

**Architecture:** 保留现有 Hono、Pi Runtime、SQLite 和进程内串行队列。新增 Workspace 成员关系和角色授权；在现有 Workspace Memory item 上增加作用域字段，读取时按当前 Workspace 与 SessionKey 做联合过滤。

**Tech Stack:** TypeScript, Node.js, Hono, better-sqlite3, Vitest, React/Vite.

---

### Task 1: Add membership schema and migration

**Files:**
- Modify: `src/database.ts`
- Test: `tests/database.test.ts`

- [x] Write failing tests for schema v10, `workspace_members`, unique `(workspace_id,user_id)`, and owner backfill.
- [x] Run `npx vitest run tests/database.test.ts` and verify the new assertions fail because the table/version is absent.
- [x] Add idempotent v10 migration, increment `CURRENT_SCHEMA_VERSION`, and create the membership table with owner/admin/member role validation.
- [x] Backfill each non-empty `workspaces.owner` as an owner membership using `INSERT OR IGNORE`.
- [x] Run the database test file again and confirm it passes.

### Task 2: Add workspace membership domain helpers

**Files:**
- Modify: `src/models.ts`
- Test: `tests/multi-user.test.ts`

- [x] Write failing tests for adding a member, rejecting a duplicate membership, listing members, and checking a member role.
- [ ] Run the focused tests and verify failure from missing helpers.
- [x] Implement typed `WorkspaceMember`, `addWorkspaceMember`, `listWorkspaceMembers`, `getWorkspaceMembership`, and `requireWorkspaceMembership` helpers.
- [x] Change workspace bootstrap so a user with an existing membership reuses that Workspace; preserve orphan takeover for legacy data.
- [ ] Run `npx vitest run tests/multi-user.test.ts` and confirm existing isolation tests remain green.

### Task 3: Enforce shared-workspace authorization in the API

**Files:**
- Modify: `src/server.ts`
- Modify: `src/auth.ts` only if session helpers need a workspace context
- Test: `tests/server.test.ts`, `tests/multi-user.test.ts`

- [x] Write failing endpoint tests for a shared member accessing the Workspace, a non-member receiving 403, and member/admin differences for persona, channels, tasks, and team-memory mutation.
- [ ] Run focused server tests and verify the authorization assertions fail.
- [x] Update API middleware to resolve the active/default Workspace from membership instead of assuming `owner === user.id`.
- [x] Add small role guards: members can chat and create conversation memory; admins/owners can mutate persona, channels, tasks, and team memory; owners/admins can manage members.
- [x] Return stable 401/403/404 responses without exposing another Workspace.
- [ ] Run the focused server and multi-user tests.

### Task 4: Add scoped memory fields and migration compatibility

**Files:**
- Modify: `src/database.ts`
- Modify: `src/memory.ts`
- Test: `tests/memory.test.ts`

- [ ] Write failing tests for workspace memory visibility, conversation memory visibility, cross-conversation exclusion, and legacy rows defaulting to workspace scope.
- [ ] Run `npx vitest run tests/memory.test.ts` and verify scope assertions fail.
- [x] Add `scope_type` and nullable `scope_key` fields with a default of `workspace`; keep revision, idempotency, version, tombstone, and FTS behavior intact.
- [x] Extend create/search/list APIs with a `MemoryScope` input and filter all reads by the supplied workspace/session scope.
- [x] Keep `workspace` memory visible to all sessions in that Workspace; only match `conversation` memory when `scope_key === sessionKey`.
- [ ] Run the memory tests and confirm old behavior remains compatible for workspace-only callers.

### Task 5: Route Agent memory through the current turn

**Files:**
- Modify: `src/runtime-context.ts`
- Modify: `src/memory-tools.ts`
- Modify: `src/server.ts`
- Modify: `src/gateway.ts`
- Test: `tests/agent-runtime.test.ts`, `tests/multi-user.test.ts`

- [ ] Write failing tests proving `recall_memory` sees Workspace plus current-session memory, but not another session; prove `remember_memory` defaults to conversation scope.
- [ ] Run the focused tests and verify the new behavior fails.
- [x] Add `actorUserId` and the current `sessionKey` to `TurnContext` where available.
- [ ] Add a validated `scope` option to `remember_memory`, defaulting to `conversation`; allow `workspace` only when the caller has the appropriate role context.
- [ ] Pass session context into `searchMemory` and `createMemory`, and update tool descriptions to explain the scope policy.
- [ ] Run focused Agent/multi-user tests.

### Task 6: Track actor identity in tool calls and confirmations

**Files:**
- Modify: `src/permission-loop.ts`
- Modify: `src/tools.ts`
- Modify: `src/models.ts`
- Modify: `src/server.ts`
- Test: `tests/permission.test.ts`, `tests/multi-user.test.ts`

- [ ] Write failing tests for a pending action recording its requester and allowing only the requester or an admin to confirm it.
- [ ] Run the focused permission tests and verify failure.
- [x] Extend turn context and pending actions with requester identity while keeping session ownership checks.
- [x] Persist requester metadata in tool-call records where schema permits; add a migration because the existing table had no actor column.
- [ ] Run permission and multi-user tests.

### Task 7: Add shared-team UI/API surface

**Files:**
- Modify: `src/server.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Create or modify: `web/src/components/SettingsView.tsx`
- Test: `tests/server.test.ts`

- [ ] Write failing API tests for listing members, adding a member by username, changing role, and rejecting member-management calls from ordinary members.
- [ ] Run focused API tests and verify failure.
- [x] Implement the member/Agent/workspace endpoints and add a compact Settings section showing current role, members, Agents, and Workspace switching.
- [ ] Keep existing persona/memory/task views mounted and preserve their current API contracts.
- [ ] Run API tests and build the frontend.

### Task 8: Full verification and documentation

**Files:**
- Modify: `README.md`
- Modify: `DEVELOPMENT_PLAN.md` only if its status is stale

- [x] Run `npm test`.
- [x] Run `npm run web:build`.
- [x] Run focused tests covering two members in one Workspace, two conversation scopes, and permission confirmation.
- [x] Update README architecture and usage sections to describe shared Workspace membership and scoped memory accurately.
- [x] Inspect the final code paths and verify the relevant commands before claiming completion.
