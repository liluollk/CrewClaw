import { create } from 'zustand';
import { api } from '../api/client';
import type { MeResponse, UserPublic, WorkspaceRole } from '../types';

interface AuthState {
  authenticated: boolean;
  user: UserPublic | null;
  workspaceId: string | null;
  role: WorkspaceRole | null;
  initialized: boolean | null; // null = 尚未检查
  checking: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (data: { username: string; password: string; displayName?: string }) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  /** 权限判断：无 permissions[]，以工作区角色替代（owner/admin 可管理） */
  canManage: () => boolean;
}

/** index.html 预热的 /api/auth/me 结果（省一次 RTT） */
function consumePrewarm(): Promise<MeResponse | null> | null {
  if (typeof window === 'undefined') return null;
  const p = (window as unknown as { __authPrewarm?: Promise<Response> }).__authPrewarm;
  if (!p) return null;
  return p.then((res) => (res.ok ? res.json() : null)).catch(() => null) as Promise<MeResponse | null>;
}

let prewarm: Promise<MeResponse | null> | null | undefined;

export const useAuthStore = create<AuthState>((set, get) => ({
  authenticated: false,
  user: null,
  workspaceId: null,
  role: null,
  initialized: null,
  checking: true,

  login: async (username, password) => {
    await api.post<{ user: UserPublic }>('/api/auth/login', { username, password });
    set({ initialized: true });
    await get().checkAuth();
  },

  register: async (data) => {
    await api.post<{ user: UserPublic }>('/api/auth/register', data);
    set({ initialized: true });
    await get().checkAuth();
  },

  logout: async () => {
    await api.post('/api/auth/logout');
    set({ authenticated: false, user: null, workspaceId: null, role: null, initialized: true });
  },

  checkAuth: async () => {
    set({ checking: true });
    try {
      // 预热结果只在首次检查时消费；登录/登出后的检查必须拿权威状态，
      // 否则会把登录前"未登录"的预热结果误当成最新状态。
      let data: MeResponse | null;
      if (get().initialized === null) {
        prewarm ??= consumePrewarm();
        data = (await prewarm) ?? null;
      } else {
        data = await api.get<MeResponse>('/api/auth/me').catch(() => null);
      }
      if (data?.user) {
        set({
          authenticated: true,
          user: data.user,
          workspaceId: data.workspaceId,
          role: data.role,
          initialized: true,
        });
      } else {
        set({ authenticated: false, user: null, workspaceId: null, role: null, initialized: true });
      }
    } finally {
      set({ checking: false });
    }
  },

  canManage: () => get().role === 'owner' || get().role === 'admin',
}));
