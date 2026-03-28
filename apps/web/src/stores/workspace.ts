/**
 * Workspace Zustand Store
 *
 * 기존 React Context(workspace-context.tsx)를 Zustand로 전환한 전역 상태.
 * - persist 미들웨어로 localStorage 동기화 (workspaceId만 유지)
 * - Provider 없이 어디서든 useWorkspaceStore() 호출로 접근 가능
 *
 * ── 상태 구조 ──────────────────────────────────
 *  workspaceId    : 현재 선택된 워크스페이스 ID (localStorage 유지)
 *  workspaceName  : 현재 워크스페이스 이름 (표시용, 비유지)
 *  workspaces     : 전체 워크스페이스 목록 (API 조회 결과, 비유지)
 * ────────────────────────────────────────────────
 */
'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/* ─── 타입 ─── */
export interface WorkspaceItem {
  id: string;
  name: string;
  createdAt: string;
}

interface WorkspaceState {
  /* 상태 */
  workspaceId: string | null;
  workspaceName: string | null;
  workspaces: WorkspaceItem[];

  /* 액션 */
  /** 워크스페이스 전환 — workspaceName을 목록에서 자동 갱신 */
  setWorkspace: (id: string | null) => void;
  /** API 결과로 목록 전체 교체 + 현재 workspaceName 갱신 */
  setWorkspaces: (workspaces: WorkspaceItem[]) => void;
  /** /api/workspaces 를 호출해 목록 새로고침 */
  refreshWorkspaces: () => Promise<void>;
}

/* ─── Store ─── */
export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      /* ── 초기값 ── */
      workspaceId: null,
      workspaceName: null,
      workspaces: [],

      /* ── 워크스페이스 전환 ── */
      setWorkspace: (id) => {
        if (!id) {
          set({
            workspaceId: null,
            workspaceName: null,
          });
          return;
        }

        const found = get().workspaces.find((w) => w.id === id);
        set({
          workspaceId: id,
          workspaceName: found?.name ?? null,
        });
      },

      /* ── 목록 갱신 (API 결과 반영) ── */
      setWorkspaces: (workspaces) => {
        const currentId = get().workspaceId;
        const found = currentId
          ? workspaces.find((w) => w.id === currentId)
          : null;
        set({
          workspaces,
          // 현재 ID가 목록에 없으면 미선택 상태로 전환 (implicit default 제거)
          workspaceId: found ? currentId : null,
          workspaceName: found?.name ?? null,
        });
      },

      /* ── 서버에서 목록 fetch ── */
      refreshWorkspaces: async () => {
        try {
          const res = await fetch('/api/workspaces', { cache: 'no-store' });
          if (!res.ok) return;

          const data = (await res.json()) as WorkspaceItem[];
          const currentId = get().workspaceId;
          const found = currentId
            ? data.find((w) => w.id === currentId)
            : null;

          set({
            workspaces: data,
            workspaceId: found ? currentId : null,
            workspaceName: found?.name ?? null,
          });
        } catch {
          console.error('[WorkspaceStore] 워크스페이스 목록 로드 실패');
        }
      },
    }),
    {
      // localStorage 키 (기존 'archi-navi:workspace-id'와 구분하기 위해 새 키 사용)
      name: 'archi-navi:workspace',
      storage: createJSONStorage(() => localStorage),
      // workspaceId만 유지 — 목록/이름은 마운트 시 refreshWorkspaces()로 복원
      partialize: (state) => ({ workspaceId: state.workspaceId }),
    },
  ),
);

/* ─── 하위 호환 훅 ── useWorkspace() 로 기존 코드 호환 ─── */
export const useWorkspace = useWorkspaceStore;
