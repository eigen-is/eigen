import { getDriveAppUrl, getDriveItemUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { usePublicUsers } from '@workspace/lib/public';
import type { DriveItemRef, DrivePath } from '@workspace/lib/types/drive';
import { aclPrincipalsToResolve, describeFileEvent, type FileEvent } from '@workspace/lib/types/file-history';
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

    // Names for the principals rows render: emails inside comment previews (mentions, emote targets),
    // the 'assigned' target, and the acl-changed diff's team entries — describeFileEvent renders its
    // emails as-is. usePublicUsers resolves users and teams alike.
    const principals = useMemo(() => {
        const set = new Set<string>();
        for (const e of events) {
            if (e.eventType === 'commented' && e.details && 'preview' in e.details)
                for (const m of e.details.preview.match(EMAIL_FIND_REGEX) ?? []) set.add(m);
            if (e.eventType === 'assigned' && e.details && 'assignee' in e.details) set.add(e.details.assignee);
            if (e.eventType === 'acl-changed') for (const id of aclPrincipalsToResolve(e.details)) set.add(id);
        }
        return [...set];
    }, [events]);
    const publicUsers = usePublicUsers(principals);
    const previewOpts = useMemo(
        () => ({ resolveName: (idOrEmail: string) => publicUsers[idOrEmail]?.name, viewerEmail: user?.email }),
        [publicUsers, user?.email],
    );

    const isFolder = path.type === 'folder';

    return (
        <>
            {events.map((event) => {
                // 'own' = the file's own events (panel title already names it); else name the item.
                const ctx = !isFolder && event.pathId === path.id ? 'own' : 'container';
                const lines = describeFileEvent(event, ctx, previewOpts);
                const target = resolveRowTarget(event, path, ctx, onOpenCard);

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
                        {...target}
                    />
                );
            })}
        </>
    );
}

// In-editor mode (onOpenCard set) opens card/comment rows in-doc and leaves every other row inert;
// drive mode hands the row its resolveEventUrl deep-link, so the row is an anchor the user can also
// cmd/middle-click into a new tab. Either side may be empty: that row has no target and stays inert.
function resolveRowTarget(
    event: FileEvent,
    path: DrivePath,
    ctx: 'own' | 'container',
    onOpenCard?: (ref: CardOpenRef) => void,
): { href?: string; onOpen?: () => void } {
    if (onOpenCard) {
        const ref = resolveEventCardRef(event);
        return ref ? { onOpen: () => onOpenCard(ref) } : {};
    }
    return { href: resolveEventUrl(event, path, ctx) };
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

// Row click target per Inventory B: deep-links for sticky/comment, share dialog for acl-changed, item open
// otherwise.
function resolveEventUrl(event: FileEvent, path: DrivePath, ctx: 'own' | 'container'): string | undefined {
    if (event.eventType === 'trashed' || event.eventType === 'deleted') return undefined;

    // Folder behind the fs share-dialog / ?pid= select: own → the item's parent, container → the folder we're viewing.
    const parentIdOrSelf = ctx === 'own' ? (path.parentId ?? path.id) : path.id;

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

    const fsLink = (query: string) => getDriveAppUrl(`fs/${path.ownerId}/${path.mountId}/${parentIdOrSelf}?${query}`);

    if (event.eventType === 'acl-changed') return fsLink(`sharePathId=${event.pathId}`);

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
    return itemUrl ?? fsLink(`pid=${event.pathId}`);
}
