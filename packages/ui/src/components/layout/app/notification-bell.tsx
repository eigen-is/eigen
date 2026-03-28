import { driveApi, getCalendarAppUrl, getDocumentUrl, getDriveAppUrl, getMailAppUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth/auth-context.tsx';
import { formatTimeAgo } from '@workspace/lib/date';
import {
    useDismissNotification,
    useMarkAllNotificationsRead,
    useMarkNotificationRead,
    useNotifications,
    useUnreadNotificationCount,
} from '@workspace/lib/notification';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Notification } from '@workspace/lib/types/notification';
import { Bell, Check, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../button';
import { Popover, PopoverContent, PopoverTrigger } from '../../popover';
import { UserAvatar } from '../user-avatar';

function parseDriveTag(tag: string | null): { ownerId: string; mountId: string; pathId: string } | null {
    if (!tag) return null;
    // Matches share:{ownerId}:{mountId}:{pathId} and mention:{ownerId}:{mountId}:{pathId}:{email}
    const [prefix, ownerId, mountId, pathId] = tag.split(':');
    if (!['share', 'mention'].includes(prefix) || !ownerId || !mountId || !pathId) return null;
    return { ownerId, mountId, pathId };
}

async function resolveDriveLink(tag: string | null): Promise<string> {
    const parsed = parseDriveTag(tag);
    if (!parsed) return getDriveAppUrl();

    const response = await driveApi({ ownerId: parsed.ownerId })({ mountId: parsed.mountId })
        .path({ pathId: parsed.pathId })
        .get();
    const path = response.data as DrivePath | null;
    if (!path) return getDriveAppUrl();

    return getDocumentUrl(path) || getDriveAppUrl(`fs/${path.ownerId}/${path.mountId}/${path.id}`);
}

function resolveLink(notification: Notification): string | null {
    switch (notification.type) {
        case 'share':
        case 'mention-chat':
        case 'mention-comment':
        case 'calendar-share':
        case 'calendar-unshare':
        case 'calendar-invite':
        case 'calendar-invite-updated':
        case 'calendar-invite-cancelled':
        case 'mail':
            return notification.type;
        default:
            return null;
    }
}

async function navigateToNotification(notification: Notification): Promise<void> {
    switch (notification.type) {
        case 'share':
        case 'mention-chat':
        case 'mention-comment':
            window.location.href = await resolveDriveLink(notification.tag);
            return;
        case 'calendar-share':
        case 'calendar-unshare':
        case 'calendar-invite':
        case 'calendar-invite-updated':
        case 'calendar-invite-cancelled':
            window.location.href = getCalendarAppUrl();
            return;
        case 'mail':
            window.location.href = getMailAppUrl('box/inbox');
            return;
    }
}

type NotificationItemProps = {
    notification: Notification;
    onMarkRead: (id: string) => void;
    onDismiss: (id: string) => void;
};

function NotificationItem({ notification, onMarkRead, onDismiss }: NotificationItemProps) {
    const isClickable = resolveLink(notification) !== null;

    const handleClick = async () => {
        if (!notification.read) onMarkRead(notification.id);
        await navigateToNotification(notification);
    };

    return (
        <div
            className={`flex items-start gap-3 px-3 py-2.5 transition-colors ${isClickable ? 'cursor-pointer hover:bg-muted/50' : ''} ${!notification.read ? 'bg-primary/5' : ''}`}
            onClick={handleClick}
        >
            {notification.actorEmail && (
                <div className="shrink-0 pt-0.5">
                    <UserAvatar email={notification.actorEmail} size="sm" />
                </div>
            )}
            <div className="flex-1 min-w-0">
                <p
                    className={`text-sm leading-tight truncate ${!notification.read ? 'font-medium' : 'text-muted-foreground'}`}
                >
                    {notification.title}
                </p>
                {notification.body && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{notification.body}</p>
                )}
                <p className="text-xs text-muted-foreground/70 mt-0.5">{formatTimeAgo(notification.createdAt)}</p>
            </div>
            <Button
                variant="ghost"
                size="icon"
                className="shrink-0 h-6 w-6 opacity-0 group-hover/item:opacity-100"
                onClick={(e) => {
                    e.stopPropagation();
                    onDismiss(notification.id);
                }}
            >
                <X className="h-3 w-3" />
            </Button>
        </div>
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

    if (!auth.isAuthenticated) return null;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="relative h-8 w-8 text-white hover:bg-primary/20 hover:text-white"
                >
                    <Bell className="h-4 w-4" />
                    {count > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
                            {count > 99 ? '99+' : count}
                        </span>
                    )}
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
