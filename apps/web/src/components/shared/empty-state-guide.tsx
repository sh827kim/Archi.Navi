import Link from 'next/link';
import { cn } from '@archi-navi/ui';

interface EmptyStateAction {
  href: string;
  label: string;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
}

export function EmptyStateGuide({
  eyebrow,
  title,
  description,
  actions,
  note,
  className,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions: EmptyStateAction[];
  note?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-2xl flex-col items-center gap-4 rounded-3xl border border-border/70 bg-background/80 px-6 py-8 text-center shadow-sm backdrop-blur-sm',
        className,
      )}
    >
      {eyebrow ? (
        <span className="rounded-full border border-primary/20 bg-primary/8 px-3 py-1 text-[11px] font-medium tracking-[0.18em] text-primary uppercase">
          {eyebrow}
        </span>
      ) : null}
      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-foreground">{title}</h3>
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {actions.map((action) => (
          <Link
            key={`${action.href}:${action.label}`}
            href={action.href}
            className={cn(
              'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors',
              action.variant === 'outline'
                ? 'border border-border bg-background text-foreground hover:bg-accent'
                : action.variant === 'ghost'
                  ? 'text-foreground hover:bg-accent'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {action.label}
          </Link>
        ))}
      </div>
      {note ? <p className="text-xs leading-5 text-muted-foreground">{note}</p> : null}
    </div>
  );
}
