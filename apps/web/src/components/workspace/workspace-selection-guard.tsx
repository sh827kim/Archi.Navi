'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '@/contexts/workspace-context';
import { WorkspaceLoadingSkeleton } from '@/components/workspace/workspace-loading-skeleton';

export function WorkspaceSelectionGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { workspaceId, workspaces, refreshWorkspaces } = useWorkspace();
  const [checked, setChecked] = useState(workspaces.length > 0);

  const isValidSelection = useMemo(
    () => !!workspaceId && workspaces.some((ws) => ws.id === workspaceId),
    [workspaceId, workspaces],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshWorkspaces();
      if (!cancelled) setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshWorkspaces]);

  useEffect(() => {
    if (workspaces.length > 0) {
      setChecked(true);
    }
  }, [workspaces]);

  useEffect(() => {
    if (!checked) return;
    if (!isValidSelection) {
      router.replace('/workspaces');
    }
  }, [checked, isValidSelection, router]);

  if (!checked) {
    return <WorkspaceLoadingSkeleton variant="guard" />;
  }

  if (!isValidSelection) {
    return null;
  }

  return <>{children}</>;
}
