'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '@/contexts/workspace-context';

export function WorkspaceSelectionGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { workspaceId, workspaces, refreshWorkspaces } = useWorkspace();
  const [checked, setChecked] = useState(false);

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
    if (!checked) return;
    if (!isValidSelection) {
      router.replace('/workspaces');
    }
  }, [checked, isValidSelection, router]);

  if (!checked) {
    return <div className="h-screen w-full bg-background" />;
  }

  if (!isValidSelection) {
    return null;
  }

  return <>{children}</>;
}
