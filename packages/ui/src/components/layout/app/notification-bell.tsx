import { useAuth } from '@workspace/lib/auth/auth-context.tsx';
import {
    describeNotification,
    isClickableNotification,
    resolveNotificationLink,
    useDismissNotification,
    useMarkAllNotificationsRead,
    useMarkNotificationRead,
    useNotifications,
    useUnreadNotificationCount,
} from '@workspace/lib/notification';
import { usePublicUsers } from '@workspace/lib/public';
import type { Notification } from '@workspace/lib/types/notification';
import { EMAIL_FIND_REGEX } from '@workspace/lib/validation';
import { Bell, Check, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '../../button';
import { Popover, PopoverContent, PopoverTrigger } from '../../popover';
import { ActivityRow } from '../activity-row';
import { CountBadge } from '../count-badge';
import { NotificationBadge } from './notification-badge';

type NotificationItemProps = {
    notification: Notification;
    previewOpts: { resolveName?: (email: string) => string | undefined; viewerEmail?: string };
    onMarkRead: (id: string) => void;
    onDismiss: (id: string) => void;
};

function NotificationItem({ notification, previewOpts, onMarkRead, onDismiss }: NotificationItemProps) {
    const lines = describeNotification(notification, previewOpts);
    const details = notification.details;
    const pathType = details && 'pathType' in details ? details.pathType : undefined;

    const handleOpen = async () => {
        if (!notification.read) onMarkRead(notification.id);
        const url = await resolveNotificationLink(notification);
        if (url) window.location.assign(url);
    };

    return (
        <ActivityRow
            actorEmail={notification.actorEmail}
            badge={<NotificationBadge type={notification.type} pathType={pathType} />}
            action={lines.action}
            primary={lines.primary}
            secondary={lines.secondary}
            createdAt={notification.createdAt}
            unread={!notification.read}
            onOpen={isClickableNotification(notification.type) ? handleOpen : undefined}
            trailing={
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Dismiss notification"
                    className="shrink-0 h-6 w-6 opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                    onClick={(e) => {
                        e.stopPropagation();
                        onDismiss(notification.id);
                    }}
                >
                    <X className="h-3 w-3" />
                </Button>
            }
        />
    );
}

export function NotificationBell() {
    const [open, setOpen] = useState(false);
    const auth = useAuth();
    const ownerId = auth.user?.id ?? '';
    const { data: count = 0 } = useUnreadNotificationCount(ownerId);
    const { data: notifications = [] } = useNotifications(ownerId, open);
    const markAllRead = useMarkAllNotificationsRead(ownerId);
    const markRead = useMarkNotificationRead(ownerId);
    const dismiss = useDismissNotification(ownerId);

    // Resolve display names for the emails embedded in chat-derived bodies (mentions, emote targets).
    const emails = useMemo(() => {
        const set = new Set<string>();
        for (const n of notifications) for (const m of n.body?.match(EMAIL_FIND_REGEX) ?? []) set.add(m);
        return [...set];
    }, [notifications]);
    const publicUsers = usePublicUsers(emails);
    const previewOpts = useMemo(
        () => ({ resolveName: (email: string) => publicUsers[email]?.name, viewerEmail: auth.user?.email }),
        [publicUsers, auth.user?.email],
    );

    if (!auth.isAuthenticated) return null;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
                    className="relative h-8 w-8 text-[var(--topbar-icon)] hover:bg-[var(--topbar-icon-hover-bg)] hover:text-[var(--topbar-icon-hover-fg)]"
                >
                    <Bell className="h-4 w-4" />
                    <CountBadge count={count} />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-0" align="end">
                <div className="flex items-center justify-between px-3 py-2 border-b">
                    <span className="text-sm font-medium">Notifications</span>
                    {count > 0 && (
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => markAllRead.mutate()}>
                            <Check className="h-3 w-3 mr-1" />
                            Mark all read
                        </Button>
                    )}
                </div>
                <div className="max-h-80 overflow-y-auto">
                    {notifications.length === 0 ? (
                        <div className="px-3 py-8 text-center text-sm text-muted-foreground">No notifications</div>
                    ) : (
                        notifications.map((n) => (
                            <div key={n.id} className="group/item border-b last:border-b-0">
                                <NotificationItem
                                    notification={n}
                                    previewOpts={previewOpts}
                                    onMarkRead={(id) => markRead.mutate(id)}
                                    onDismiss={(id) => dismiss.mutate(id)}
                                />
                            </div>
                        ))
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}
