/**
 * WorkspaceSwitcher
 * 사이드바 상단의 워크스페이스 선택 팝오버
 * - 현재 워크스페이스 표시
 * - 전환 / 신규 생성 / 삭제 지원
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronDown,
  Check,
  Trash2,
  FolderOpen,
  Settings2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  ConfirmDialog,
} from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';

export function WorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const router = useRouter();
  const { workspaceId, workspaceName, workspaces, setWorkspace, refreshWorkspaces } =
    useWorkspace();

  const [open, setOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  /* ─── 워크스페이스 삭제 ─── */
  const deleteWorkspace = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/workspaces/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');

      // 현재 선택된 워크스페이스 삭제 시 미선택 상태로 전환 후 목록으로 이동
      if (workspaceId === deleteTarget.id) {
        setWorkspace(null);
        router.push('/workspaces');
      }
      await refreshWorkspaces();
      toast.success(`"${deleteTarget.name}" 워크스페이스 삭제됨`);
    } catch {
      toast.error('워크스페이스 삭제 실패');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* 현재 워크스페이스 표시 버튼 */}
          <button
            className={cn(
              'flex min-w-0 w-full items-center gap-2 rounded-lg px-3 py-2 text-left',
              'hover:bg-muted/50 transition-colors',
              'text-sm font-medium text-foreground',
              collapsed && 'justify-center px-2',
            )}
            title={workspaceName ?? '워크스페이스 선택'}
            aria-label={workspaceName ?? '워크스페이스 선택'}
          >
            <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
            {!collapsed ? (
              <>
                <span className="min-w-0 flex-1 truncate">{workspaceName ?? '워크스페이스 선택'}</span>
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-200',
                    open && 'rotate-180',
                  )}
                />
              </>
            ) : null}
          </button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-64 max-w-[calc(100vw-2rem)] p-2">
          {/* 워크스페이스 목록 */}
          <div className="space-y-0.5 mb-2">
            <p className="px-2 py-1 text-xs text-muted-foreground font-medium uppercase tracking-wider">
              워크스페이스
            </p>
            {workspaces.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                생성된 워크스페이스가 없습니다.
              </div>
            ) : (
              workspaces.map((ws) => (
                <div key={ws.id} className="flex min-w-0 items-center gap-1">
                  <button
                    onClick={() => {
                      setWorkspace(ws.id);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-sm transition-colors text-left',
                      ws.id === workspaceId
                        ? 'bg-primary/15 text-primary'
                        : 'text-foreground hover:bg-muted/50',
                    )}
                    title={ws.name}
                  >
                    {ws.id === workspaceId && (
                      <Check className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        ws.id !== workspaceId && 'pl-5',
                      )}
                    >
                      {ws.name}
                    </span>
                  </button>

                  <button
                    onClick={() => setDeleteTarget({ id: ws.id, name: ws.name })}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>

          <Separator className="my-2" />

          <button
            onClick={() => {
              setOpen(false);
              router.push('/workspaces');
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <Settings2 className="h-3.5 w-3.5" />
            워크스페이스 관리
          </button>
        </PopoverContent>
      </Popover>

      {/* 삭제 확인 다이얼로그 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="워크스페이스 삭제"
        description={`"${deleteTarget?.name}" 워크스페이스와 모든 데이터(오브젝트, 관계, 레이어)를 삭제합니다. 이 작업은 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        destructive
        loading={deleting}
        onConfirm={() => void deleteWorkspace()}
      />
    </>
  );
}
