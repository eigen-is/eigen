import { getDriveAppUrl, getDriveItemUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { usePublicUsers } from '@workspace/lib/public';
import type { DriveItemRef, DrivePath } from '@workspace/lib/types/drive';
import { describeFileEvent, type FileEvent } from '@workspace/lib/types/file-history';
import { EMAIL_FIND_REGEX } from '@workspace/lib/validation';
import { useMemo } from 'react';
import { ActivityRow } from '../activity-row';
import { UserNameCard } from '../user/user-name-card';

// A row's card/comment target, resolved by the host against its lifecycle `cards` map.
type CardOpenRef = { cardId?: string; chatName?: string };

type ActivityEventListProps = {
    path: DrivePath;
    events: FileEvent[];
    // In-editor mode: rows referencing a card/comment open it in-doc; every other row is inert (no
    // URL navigation). Absent (drive Recent Activity) keeps the resolveEventUrl deep-link behavior.
    onOpenCard?: (ref: CardOpenRef) => void;
};

export function ActivityEventList({ path, events, onOpenCard }: ActivityEventListProps) {
    const { user } = useAuth();

    // Resolve display names for emails inside comment previews (mentions, emote targets) and the
    // 'assigned' target, so both render a name rather than the email local part.
    const emails = useMemo(() => {
        const set = new Set<string>();
        for (const e of events) {
            if (e.eventType === 'commented' && e.details && 'preview' in e.details)
                for (const m of e.details.preview.match(EMAIL_FIND_REGEX) ?? []) set.add(m);
            if (e.eventType === 'assigned' && e.details && 'assignee' in e.details) set.add(e.details.assignee);
        }
        return [...set];
    }, [events]);
    const publicUsers = usePublicUsers(emails);
    const previewOpts = useMemo(
        () => ({ resolveName: (email: string) => publicUsers[email]?.name, viewerEmail: user?.email }),
        [publicUsers, user?.email],
    );

    const isFolder = path.type === 'folder';

    return (
        <>
            {events.map((event) => {
                // 'own' = the file's own events (panel title already names it); else name the item.
                const ctx = !isFolder && event.pathId === path.id ? 'own' : 'container';
                const lines = describeFileEvent(event, ctx, previewOpts);
                const onOpen = resolveRowOnOpen(event, path, ctx, onOpenCard);

                return (
                    <ActivityRow
                        key={event.id}
                        actorEmail={event.actorEmail}
                        actorUserId={event.actorUserId}
                        action={
                            <>
                                {event.actorUserId === user?.id ? (
                                    'You'
                                ) : (
                                    <UserNameCard
                                        userId={event.actorUserId}
                                        email={event.actorEmail}
                                        className="font-medium"
                                    />
                                )}{' '}
                                {lines.action}
                            </>
                        }
                        primary={lines.primary}
                        secondary={lines.secondary}
                        createdAt={event.createdAt}
                        onOpen={onOpen}
                    />
                );
            })}
        </>
    );
}

// In-editor mode (onOpenCard set) opens card/comment rows in-doc and leaves every other row inert;
// drive mode falls back to the resolveEventUrl deep-link + full navigation.
function resolveRowOnOpen(
    event: FileEvent,
    path: DrivePath,
    ctx: 'own' | 'container',
    onOpenCard?: (ref: CardOpenRef) => void,
): (() => void) | undefined {
    if (onOpenCard) {
        const ref = resolveEventCardRef(event);
        return ref ? () => onOpenCard(ref) : undefined;
    }
    const url = resolveEventUrl(event, path, ctx);
    return url
        ? () => {
              window.location.href = url;
          }
        : undefined;
}

// The card/comment a row references, or undefined for rows that don't open a card in the editor
// (sticky-removed points at a card that no longer exists; comment rows need a chatName to resolve).
function resolveEventCardRef(event: FileEvent): CardOpenRef | undefined {
    const details = event.details;
    if (event.eventType === 'sticky-added' || event.eventType === 'sticky-moved') {
        return { cardId: details && 'cardId' in details ? details.cardId : undefined };
    }
    if (
        event.eventType === 'commented' ||
        event.eventType === 'assigned' ||
        event.eventType === 'resolved' ||
        event.eventType === 'reopened'
    ) {
        const chatName = details && 'chatName' in details ? details.chatName : undefined;
        return chatName ? { chatName } : undefined;
    }
    return undefined;
}

// Row click target per Inventory B: deep-links for sticky/comment, share dialog for acl-changed, item open otherwise.
function resolveEventUrl(event: FileEvent, path: DrivePath, ctx: 'own' | 'container'): string | undefined {
    if (event.eventType === 'trashed' || event.eventType === 'deleted') return undefined;

    // Folder behind the fs share-dialog / ?pid= select: own → the item's parent, container → the folder we're viewing.
    const parentIdOrSelf = ctx === 'own' ? (path.parentId ?? path.id) : path.id;

    if (event.eventType === 'acl-changed') {
        return getDriveAppUrl(`fs/${path.ownerId}/${path.mountId}/${parentIdOrSelf}?sharePathId=${event.pathId}`);
    }

    const containerRef: DriveItemRef =
        ctx === 'own'
            ? path
            : {
                  id: event.pathId,
                  ownerId: path.ownerId,
                  mountId: path.mountId,
                  name: event.pathName,
                  type: event.pathType,
                  mimeType: '',
              };
    const itemUrl = getDriveItemUrl(containerRef);
    const details = event.details;

    if (event.eventType === 'sticky-added' || event.eventType === 'sticky-moved') {
        const cardId = details && 'cardId' in details ? details.cardId : undefined;
        return getDriveItemUrl(containerRef, { card: cardId });
    }
    if (event.eventType === 'sticky-removed') return itemUrl; // card is gone — board only
    // Comment lifecycle rows all carry chatName — deep-link to the comment, not just the doc.
    if (
        event.eventType === 'commented' ||
        event.eventType === 'assigned' ||
        event.eventType === 'resolved' ||
        event.eventType === 'reopened'
    ) {
        const chatName = details && 'chatName' in details ? details.chatName : undefined;
        return getDriveItemUrl(containerRef, { chat: chatName });
    }

    // created/edited/moved/copied/uploaded/renamed/restored/version-restored.
    return itemUrl ?? getDriveAppUrl(`fs/${path.ownerId}/${path.mountId}/${parentIdOrSelf}?pid=${event.pathId}`);
}
