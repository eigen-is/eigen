// The rows of a file's or a folder's history, one per event, such as "You edited" or "Ann restored a version". Drive's
// detail pane shows the newest few, and an editor's Activity panel shows more. describeFileEvent gives each row its
// words. In Drive a row links to what it names, and in an editor a comment or card row opens it in the document.

import { getDriveAppUrl, getDriveItemUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { usePublicUsers } from '@workspace/lib/public';
import type { DriveItemRef, DrivePath } from '@workspace/lib/types/drive';
import type { FileEvent } from '@workspace/lib/types/file-history';
import { aclPrincipalsToResolve, describeFileEvent } from '@workspace/lib/types/file-history';
import { EMAIL_FIND_REGEX } from '@workspace/lib/validation';
import { useMemo } from 'react';
import { ActivityRow } from '../activity-row';
import { UserNameCard } from '../user/user-name-card';

// The card or comment a row names, which the editor finds among its own cards.
type CardOpenRef = { cardId?: string; chatName?: string };

type ActivityEventListProps = {
    path: DrivePath;
    events: readonly FileEvent[];
    // Set in an editor: a row that names a card or a comment opens it in the document, and every other row does
    // nothing. In Drive it is not set, and each row links to what it names.
    onOpenCard?: (ref: CardOpenRef) => void;
};

export function ActivityEventList({ path, events, onOpenCard }: ActivityEventListProps) {
    const { user } = useAuth();

    // The people and teams the rows name get their names looked up, such as an email in a comment's preview, the
    // person a comment was assigned to and a team in a sharing change.
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
                // A row of the file's own event leaves its name out, because the list's title shows it.
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

// In Drive a row is a link, so it can also open in a new tab. A row with no target does nothing.
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

// The card or comment a row opens in the editor. A removed card is gone, and a comment row needs its chatName.
function resolveEventCardRef(event: FileEvent): CardOpenRef | undefined {
    const details = event.details;
    if (event.eventType === 'sticky-added' || event.eventType === 'sticky-moved') {
        return { cardId: details && 'cardId' in details ? details.cardId : undefined };
    }
    if (isCommentEvent(event)) {
        const chatName = details && 'chatName' in details ? details.chatName : undefined;
        return chatName ? { chatName } : undefined;
    }
    return undefined;
}

// Where a row links in Drive: a card or a comment in its document, the Share dialog for a sharing change, and the item
// for the rest. A trashed or deleted item has nowhere to go.
function resolveEventUrl(event: FileEvent, path: DrivePath, ctx: 'own' | 'container'): string | undefined {
    if (event.eventType === 'trashed' || event.eventType === 'deleted') return undefined;

    // The folder Drive opens to show the Share dialog or select the item: the item's own folder, or the folder listed.
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
    // A removed card is gone, so its row opens the board.
    if (event.eventType === 'sticky-removed') return itemUrl;
    if (isCommentEvent(event)) {
        const chatName = details && 'chatName' in details ? details.chatName : undefined;
        return getDriveItemUrl(containerRef, { chat: chatName });
    }

    // Every other event, such as created, renamed or a version restored, opens the item.
    return itemUrl ?? fsLink(`pid=${event.pathId}`);
}

function isCommentEvent(event: FileEvent): boolean {
    return (
        event.eventType === 'commented' ||
        event.eventType === 'assigned' ||
        event.eventType === 'resolved' ||
        event.eventType === 'reopened'
    );
}
