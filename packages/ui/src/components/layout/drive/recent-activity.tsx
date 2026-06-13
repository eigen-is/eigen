import { formatTimeAgo } from '@workspace/lib/date';
import { useFileHistory } from '@workspace/lib/drive';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { type FileEvent, fileEventVerb } from '@workspace/lib/types/file-history';
import { useEffect, useRef } from 'react';
import { UserAvatar } from '../user-avatar';

type RecentActivityProps = {
    path: DrivePath;
    highlight?: boolean;
};

export function RecentActivity({ path, highlight }: RecentActivityProps) {
    const { data: events = [] } = useFileHistory(path.ownerId, path.mountId, path.id);
    const sectionRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (highlight && sectionRef.current) {
            sectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, [highlight]);

    if (events.length === 0) return null;

    const isFolder = path.type === 'folder';

    return (
        <div ref={sectionRef}>
            <h3 className="eigen-section-label mt-6 mb-2">Recent activity</h3>
            <ul className="space-y-2">
                {events.map((event) => {
                    // Name the acted-on item except for the selected file's own events,
                    // where the panel title already shows it. A folder's own events keep
                    // the name so "created MyFolder" isn't a bare verb.
                    const showName = isFolder || event.pathId !== path.id;

                    return (
                        <li key={event.id} className="flex items-start gap-2 text-sm">
                            <UserAvatar email={event.actorEmail} size="sm" className="mt-0.5 shrink-0" />
                            <div className="min-w-0 flex-1">
                                {/* One line, clipped with an ellipsis — same as the panel's other rows. */}
                                <div className="truncate">
                                    <span className="font-medium">{event.actorEmail.split('@')[0]}</span>{' '}
                                    <ActivityPhrase
                                        event={event}
                                        showName={showName}
                                        name={stripEigenExtension(event.pathName)}
                                    />
                                </div>
                                <div className="text-xs text-muted-foreground">{formatTimeAgo(event.createdAt)}</div>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

// Bold only the names: the user (rendered by the caller), card/column/file/folder
// titles. Verbs and connectors stay plain weight.
function Name({ children }: { children: string }) {
    return <span className="font-medium">{children}</span>;
}

function ActivityPhrase({ event, showName, name }: { event: FileEvent; showName: boolean; name: string }) {
    switch (event.eventType) {
        case 'sticky-added':
        case 'sticky-moved': {
            const details = event.details;
            return (
                <>
                    {event.eventType === 'sticky-added' ? 'added' : 'moved'} <Name>{details?.card || 'a card'}</Name>
                    {details?.toColumn ? (
                        <>
                            {' to '}
                            <Name>{details.toColumn}</Name>
                        </>
                    ) : null}
                </>
            );
        }
        case 'slide-reordered':
            return <>reordered a slide</>;
        case 'commented': {
            // Shared across all eigendoc types — the comment text is the payload.
            const preview = event.details?.preview;
            const quote = preview ? `: ${preview}` : '';
            return showName ? (
                <>
                    commented on <Name>{name}</Name>
                    {quote}
                </>
            ) : (
                <>commented{quote}</>
            );
        }
        case 'acl-changed':
            return showName ? (
                <>
                    updated sharing for <Name>{name}</Name>
                </>
            ) : (
                <>updated sharing</>
            );
        default:
            return (
                <>
                    {fileEventVerb(event.eventType)}
                    {showName ? (
                        <>
                            {' '}
                            <Name>{name}</Name>
                        </>
                    ) : null}
                </>
            );
    }
}
