/**
 * workspace-context.tsx — Zustand 전환 후 하위 호환 shim
 *
 * 실제 상태 로직은 @/stores/workspace 로 이전했고,
 * 이 파일은 기존 import 경로(@/contexts/workspace-context)를 유지하기 위한 re-export.
 *
 * ── 변경 전 ──────────────────────────────────────
 *   React Context + useState + localStorage 직접 접근
 *   → Provider가 상태를 소유하고 useContext로 전달
 *
 * ── 변경 후 ──────────────────────────────────────
 *   Zustand store(@/stores/workspace)가 상태 소유
 *   → Provider 불필요, 어디서든 useWorkspaceStore() 직접 호출 가능
 *   → WorkspaceProvider는 하위 호환 래퍼만 유지
 * ────────────────────────────────────────────────
 *
 * 기존 사용 코드는 변경 없이 동작:
 *   import { useWorkspace } from '@/contexts/workspace-context'
 *   const { workspaceId, setWorkspace } = useWorkspace()
 */
'use client';

import { useWorkspaceStore } from '@/stores/workspace';

/* ─── 타입 re-export (기존 import 유지) ─── */
export type { WorkspaceItem } from '@/stores/workspace';

/* ─── 훅 re-export ─── */
export { useWorkspaceStore as useWorkspace } from '@/stores/workspace';

/* ─── WorkspaceProvider ─────────────────────────────────────────────────────
 * Zustand는 Provider가 필요 없지만,
 * layout.tsx의 <WorkspaceProvider> 래핑 호환은 유지한다.
 * ─────────────────────────────────────────────────────────────────────────── */
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
