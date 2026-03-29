'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, FolderOpen, ChevronRight } from 'lucide-react';
import { Button, Card, CardContent } from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';

export function WorkspacesPageClient() {
  const router = useRouter();
  const { workspaces, workspaceId, setWorkspace, refreshWorkspaces } = useWorkspace();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshWorkspaces();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshWorkspaces]);

  const hasWorkspaces = workspaces.length > 0;
  const selectedWorkspaceName = useMemo(
    () => workspaces.find((ws) => ws.id === workspaceId)?.name ?? null,
    [workspaces, workspaceId],
  );

  if (loading) {
    return <div className="h-screen w-full bg-background" />;
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-4xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">워크스페이스</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              작업할 워크스페이스를 선택하거나 새로 생성하세요.
            </p>
          </div>

          {hasWorkspaces && (
            <Button onClick={() => router.push('/workspaces/new')}>
              <Plus className="mr-2 h-4 w-4" />
              워크스페이스 생성
            </Button>
          )}
        </div>

        {!hasWorkspaces ? (
          <Card className="border-dashed">
            <CardContent className="flex min-h-[320px] flex-col items-center justify-center gap-4">
              <div className="rounded-full bg-primary/10 p-4">
                <FolderOpen className="h-7 w-7 text-primary" />
              </div>
              <div className="text-center">
                <p className="text-base font-medium text-foreground">아직 워크스페이스가 없습니다</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  첫 워크스페이스를 만들고 설정 마법사를 시작하세요.
                </p>
              </div>
              <Button size="lg" onClick={() => router.push('/workspaces/new')}>
                <Plus className="mr-2 h-4 w-4" />
                워크스페이스 생성
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {workspaces.map((ws) => {
              const selected = ws.id === workspaceId;
              return (
                <button
                  key={ws.id}
                  onClick={() => {
                    setWorkspace(ws.id);
                    router.push('/home');
                  }}
                  className="rounded-xl border border-border/70 bg-card px-4 py-4 text-left transition-colors hover:bg-accent/40"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{ws.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {selected ? '현재 선택됨' : '클릭하여 열기'}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {selectedWorkspaceName && hasWorkspaces && (
          <p className="mt-4 text-xs text-muted-foreground">
            현재 선택된 워크스페이스: {selectedWorkspaceName}
          </p>
        )}
      </div>
    </div>
  );
}
