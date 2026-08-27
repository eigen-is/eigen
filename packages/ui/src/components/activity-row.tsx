import { formatTimeAgo } from '@workspace/lib/date';
import { cn } from '@workspace/ui/lib/utils';
import type { KeyboardEvent, ReactNode } from 'react';
import { UserAvatar } from './user/user-avatar';

export type ActivityRowProps = {
    actorEmail: string | null;
    actorUserId?: string;
    badge?: ReactNode;
    action: ReactNode;
    primary?: ReactNode;
    secondary?: ReactNode;
    createdAt: Date;
    unread?: boolean;
    onOpen?: () => void;
    trailing?: ReactNode;
    className?: string;
};

// One row anatomy shared by the notification bell and the drive activity panel.
export function ActivityRow({
    actorEmail,
    actorUserId,
    badge,
    action,
    primary,
    secondary,
    createdAt,
    unread,
    onOpen,
    trailing,
    className,
}: ActivityRowProps) {
    const interactive = onOpen
        ? {
              role: 'button' as const,
              tabIndex: 0,
              onClick: onOpen,
              onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
                  // Only the row itself acts on Enter/Space — not keystrokes bubbling from trailing controls.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen();
                  }
              },
          }
        : {};

    return (
        <div
            className={cn(
                'flex items-start gap-3 px-3 py-2.5 transition-colors',
                onOpen && 'cursor-pointer hover:bg-muted/50',
                unread && 'bg-primary/5',
                className,
            )}
            {...interactive}
        >
            <div className="relative shrink-0 pt-0.5">
                <UserAvatar email={actorEmail ?? undefined} userId={actorUserId} size="sm" />
                {badge ? <div className="absolute -right-0.5 -bottom-0.5">{badge}</div> : null}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 line-clamp-2 text-xs text-muted-foreground">{action}</span>
                    <span className="shrink-0 text-xs text-muted-foreground/70">{formatTimeAgo(createdAt)}</span>
                </div>
                {primary ? <p className={cn('line-clamp-2 text-sm', unread && 'font-medium')}>{primary}</p> : null}
                {secondary ? <p className="line-clamp-2 text-sm text-muted-foreground">{secondary}</p> : null}
            </div>
            {trailing}
        </div>
    );
}
