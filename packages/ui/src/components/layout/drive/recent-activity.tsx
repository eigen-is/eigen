import { formatTimeAgo } from '@workspace/lib/date';
import { FILE_EVENT_ICONS, useFileHistory } from '@workspace/lib/drive';
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
                    const EventIcon = FILE_EVENT_ICONS[event.eventType];
                    const actorLabel = event.actorEmail.split('@')[0];
                    // Name the acted-on item except for the selected file's own events,
                    // where the panel title already shows it. A folder's own events keep
                    // the name so "created MyFolder" isn't a bare verb.
                    const showName = isFolder || event.pathId !== path.id;

                    return (
                        <li key={event.id} className="flex items-start gap-2 text-sm">
                            <UserAvatar email={event.actorEmail} size="sm" className="mt-0.5 shrink-0" />
                            <div className="min-w-0 flex-1">
                                <span className="font-medium">{actorLabel}</span>{' '}
                                <ActivityPhrase
                                    event={event}
                                    showName={showName}
                                    name={stripEigenExtension(event.pathName)}
                                />
                                <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                                    <EventIcon className="h-3 w-3" />
                                    {formatTimeAgo(event.createdAt)}
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function Strong({ children }: { children: string }) {
    return <span className="font-medium">{children}</span>;
}

// The phrase after the actor name. Semantic eigendoc events carry their own
// object (card/column) and read as full sentences; drive/collab events are a
// verb plus the acted-on item name when one adds information.
function ActivityPhrase({ event, showName, name }: { event: FileEvent; showName: boolean; name: string }) {
    switch (event.eventType) {
        case 'sticky-moved': {
            const details = event.details;
            return (
                <span>
                    moved <Strong>{details?.card || 'a card'}</Strong>
                    {details?.toColumn ? (
                        <>
                            {' to '}
                            <Strong>{details.toColumn}</Strong>
                        </>
                    ) : null}
                </span>
            );
        }
        case 'slide-reordered':
            return <span>reordered a slide</span>;
        case 'commented':
            return showName ? (
                <span>
                    commented on <Strong>{name}</Strong>
                </span>
            ) : (
                <span>added a comment</span>
            );
        case 'acl-changed':
            return showName ? (
                <span>
                    updated sharing for <Strong>{name}</Strong>
                </span>
            ) : (
                <span>updated sharing</span>
            );
        default:
            return (
                <span>
                    {fileEventVerb(event.eventType)}
                    {showName ? (
                        <>
                            {' '}
                            <Strong>{name}</Strong>
                        </>
                    ) : null}
                </span>
            );
    }
}
