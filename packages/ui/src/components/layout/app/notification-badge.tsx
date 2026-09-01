import { EIGEN_DOC_ICONS } from '@workspace/lib/eigendoc-icons';
import { type DrivePathType, getEigenDocInfoByType, isFolderType } from '@workspace/lib/types/drive';
import { AlertTriangle, Calendar, File, Folder, type LucideIcon, Mail, MessageSquare } from 'lucide-react';

// Notification type (+ path type when known) → app icon + color for the bell avatar badge (spec § App badge).
function pathTypeBadge(pathType: DrivePathType): { icon: LucideIcon; colorVar: string } {
    const info = getEigenDocInfoByType(pathType);
    if (info) return { icon: EIGEN_DOC_ICONS[info.type], colorVar: info.colorVar };
    return { icon: isFolderType(pathType) ? Folder : File, colorVar: '--app-drive-color' };
}

function badgeFor(type: string, pathType?: DrivePathType): { icon: LucideIcon; colorVar: string } {
    switch (type) {
        case 'mail':
            return { icon: Mail, colorVar: '--app-mail-color' };
        case 'calendar-share':
        case 'calendar-unshare':
        case 'calendar-invite':
        case 'calendar-invite-updated':
        case 'calendar-invite-cancelled':
            return { icon: Calendar, colorVar: '--app-calendar-color' };
        case 'mention-chat':
        case 'chat-message':
            return { icon: MessageSquare, colorVar: '--app-chat-color' };
        case 'mention-comment':
        case 'comment-reply':
            return pathType ? pathTypeBadge(pathType) : { icon: MessageSquare, colorVar: '--app-chat-color' };
        case 'admin-alert':
            return { icon: AlertTriangle, colorVar: '--app-admin-color' };
        default:
            // share, unshare, access-request, file-event, and any legacy type.
            return pathType ? pathTypeBadge(pathType) : { icon: Folder, colorVar: '--app-drive-color' };
    }
}

export function NotificationBadge({ type, pathType }: { type: string; pathType?: DrivePathType }) {
    const { icon: Icon, colorVar } = badgeFor(type, pathType);
    return (
        <span
            className="flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ring-popover"
            style={{ backgroundColor: `var(${colorVar})` }}
        >
            <Icon className="h-2.5 w-2.5 text-white" />
        </span>
    );
}
