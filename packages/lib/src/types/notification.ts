import type { DrivePathType } from './drive';

export type NotificationType =
    | 'share'
    | 'unshare'
    | 'calendar-share'
    | 'calendar-unshare'
    | 'calendar-invite'
    | 'calendar-invite-updated'
    | 'calendar-invite-cancelled'
    | 'mail'
    | 'mention-chat'
    | 'mention-comment'
    | 'chat-message'
    | 'comment-reply'
    | 'assigned'
    | 'access-request'
    | 'file-event'
    | 'admin-alert';

export type NotificationDetailsMap = {
    mail: { mailId: string; snippet?: string };
    'calendar-invite': { startTime: number };
    'calendar-invite-updated': { startTime: number };
    share: { pathType?: DrivePathType };
    unshare: { pathType?: DrivePathType };
    'mention-comment': { pathType?: DrivePathType };
    'comment-reply': { pathType?: DrivePathType };
    assigned: { pathType?: DrivePathType };
    'access-request': { message?: string; pathType?: DrivePathType };
    'file-event': { secondary?: string; cardId?: string; chatName?: string; pathType?: DrivePathType };
};

export type NotificationDetails = NotificationDetailsMap[keyof NotificationDetailsMap];

// Discriminated write input: details allowed exactly when the type carries them. Mirrors
// FileEventInput in file-history.ts.
export type NotificationPersistInput = {
    [K in NotificationType]: {
        type: K;
        actorEmail?: string | null;
        title: string;
        body?: string | null;
        tag?: string | null;
        coalesce?: boolean;
    } & (K extends keyof NotificationDetailsMap ? { details?: NotificationDetailsMap[K] } : { details?: undefined });
}[NotificationType];

// type stays `string`: persisted rows can hold retired type strings and there is no honest
// coercion target — the NotificationType union types the producers, not the read shape.
export type Notification = {
    id: string;
    type: string;
    actorEmail: string | null;
    title: string;
    body: string | null;
    tag: string | null;
    read: boolean;
    createdAt: Date;
    details: NotificationDetails | null;
};
