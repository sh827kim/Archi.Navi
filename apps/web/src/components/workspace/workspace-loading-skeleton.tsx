interface WorkspaceLoadingSkeletonProps {
  variant?: 'page' | 'guard';
}

export function WorkspaceLoadingSkeleton({
  variant = 'page',
}: WorkspaceLoadingSkeletonProps) {
  return (
    <div data-testid="workspace-loading-skeleton" className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-4xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div className="space-y-3">
            <div className="h-8 w-40 animate-pulse rounded-md bg-muted/60" />
            <div className="h-4 w-72 animate-pulse rounded-md bg-muted/40" />
          </div>
          {variant === 'page' ? (
            <div className="h-10 w-36 animate-pulse rounded-md bg-muted/50" />
          ) : null}
        </div>

        <div className="rounded-2xl border border-border/70 bg-card p-5">
          <div className="space-y-3">
            <div className="h-12 w-full animate-pulse rounded-xl bg-muted/50" />
            <div className="h-12 w-full animate-pulse rounded-xl bg-muted/40" />
            <div className="h-12 w-full animate-pulse rounded-xl bg-muted/30" />
          </div>
        </div>
      </div>
    </div>
  );
}
