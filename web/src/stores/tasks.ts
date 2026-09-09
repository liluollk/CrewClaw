import { create } from 'zustand';
import { api } from '../api/client';
import type { ScheduledTask, TaskRun } from '../types';

interface TasksState {
  tasks: ScheduledTask[];
  loaded: boolean;
  load: () => Promise<void>;
  create: (input: { name: string; prompt: string; schedule: unknown }) => Promise<void>;
  update: (
    id: string,
    patch: Partial<{ name: string; prompt: string; schedule: unknown; enabled: boolean }>,
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  listRuns: (id: string) => Promise<TaskRun[]>;
  runNow: (id: string) => Promise<void>;
}

/** 定时任务 store（对齐 /api/tasks* 端点与 ScheduleSpec） */
export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  loaded: false,
  load: async () => {
    const rows = await api.get<ScheduledTask[]>('/api/tasks');
    set({ tasks: rows, loaded: true });
  },
  create: async (input) => {
    await api.post('/api/tasks', input);
    await get().load();
  },
  update: async (id, patch) => {
    await api.put(`/api/tasks/${id}`, patch);
    await get().load();
  },
  remove: async (id) => {
    await api.delete(`/api/tasks/${id}`);
    await get().load();
  },
  listRuns: (id) => api.get<TaskRun[]>(`/api/tasks/${id}/runs`),
  runNow: async (id) => {
    await api.post(`/api/tasks/${id}/run`);
  },
}));
