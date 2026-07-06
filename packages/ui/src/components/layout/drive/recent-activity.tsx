import { getDriveAppUrl, getDriveItemUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth/auth-context.tsx';
import { useFileHistory } from '@workspace/lib/drive';
import { usePublicUsers } from '@workspace/lib/public';
import type { DriveItemRef, DrivePath } from '@workspace/lib/types/drive';
import { describeFileEvent, type FileEvent } from '@workspace/lib/types/file-history';
import { EMAIL_FIND_REGEX } from '@workspace/lib/validation';
import { useEffect, useMemo, useRef } from 'react';
import { ActivityRow } from '../activity-row';
import { UserNameCard } from '../user-name-card';

type RecentActivityProps = {
    path: DrivePath;
    highlight?: boolean;
};

export function RecentActivity({ path, highlight }: RecentActivityProps) {
    const { data: events = [] } = useFileHistory(path.ownerId, path.mountId, path.id);
    const { user } = useAuth();
    const sectionRef = useRef<HTMLDivElement>(null);

    // events.length is a dep so the scroll fires once the async history resolves
    // (the section is unmounted while the list is empty, so highlight alone misses).
    useEffect(() => {
        if (highlight && sectionRef.current) {
            sectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, [highlight, events.length]);

    // Resolve display names for the emails inside comment previews (mentions, emote targets).
    const emails = useMemo(() => {
        const set = new Set<string>();
        for (const e of events)
            if (e.eventType === 'commented' && e.details && 'preview' in e.details)
                for (const m of e.details.preview.match(EMAIL_FIND_REGEX) ?? []) set.add(m);
        return [...set];
    }, [events]);
    const publicUsers = usePublicUsers(emails);
    const previewOpts = useMemo(
        () => ({ resolveName: (email: string) => publicUsers[email]?.name, viewerEmail: user?.email }),
        [publicUsers, user?.email],
    );

    if (events.length === 0) return null;

    const isFolder = path.type === 'folder';

    return (
        <div ref={sectionRef}>
            <h3 className="eigen-section-label mt-6 mb-2">Recent activity</h3>
            {/* -mx-3 cancels the panel gutter so each row's px-3 hover fill bleeds full-width while its content stays gutter-aligned. */}
            <div className="-mx-3">
                {events.map((event) => {
                    // 'own' = the file's own events (panel title already names it); else name the item.
                    const ctx = !isFolder && event.pathId === path.id ? 'own' : 'container';
                    const lines = describeFileEvent(event, ctx, previewOpts);
                    const url = resolveEventUrl(event, path, ctx);

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
                            onOpen={
                                url
                                    ? () => {
                                          window.location.href = url;
                                      }
                                    : undefined
                            }
                        />
                    );
                })}
            </div>
        </div>
    );
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
    if (event.eventType === 'commented') {
        const chatName = details && 'chatName' in details ? details.chatName : undefined;
        return getDriveItemUrl(containerRef, { chat: chatName });
    }

    // created/edited/moved/copied/uploaded/renamed/restored/version-restored.
    return itemUrl ?? getDriveAppUrl(`fs/${path.ownerId}/${path.mountId}/${parentIdOrSelf}?pid=${event.pathId}`);
}
