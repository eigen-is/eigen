import { formatTimeAgo } from '@workspace/lib/date';
import { FILE_EVENT_ICONS, useFileHistory, useIsPathWatched, useUnwatchPath, useWatchPath } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { fileEventVerb } from '@workspace/lib/types/file-history';
import { cn } from '@workspace/ui/lib/utils';
import { useEffect, useRef } from 'react';
import { UserAvatar } from '../user-avatar';

type RecentActivityProps = {
    path: DrivePath;
    onItemOpen?: (path: DrivePath) => void;
    highlight?: boolean;
};

export function RecentActivity({ path, onItemOpen: _onItemOpen, highlight }: RecentActivityProps) {
    const { data: events = [] } = useFileHistory(path.ownerId, path.mountId, path.id, 5);
    const { data: watchStatus } = useIsPathWatched(path.ownerId, path.mountId, path.id);
    const watchMutation = useWatchPath(path.ownerId, path.mountId, path.id);
    const unwatchMutation = useUnwatchPath(path.ownerId, path.mountId, path.id);
    const sectionRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (highlight && sectionRef.current) {
            sectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, [highlight]);

    // No timeline and no watch to manage — nothing worth a section.
    if (events.length === 0 && !watchStatus?.direct && !watchStatus?.viaAncestor) return null;

    const isFolder = path.type === 'folder';
    const direct = watchStatus?.direct ?? false;

    return (
        <div ref={sectionRef}>
            <h3 className="eigen-section-label mt-6 mb-2">Recent activity</h3>
            {events.length > 0 && (
                <ul className="space-y-2 mb-3">
                    {events.map((event) => {
                        const EventIcon = FILE_EVENT_ICONS[event.eventType];
                        const isSameFile = event.pathId === path.id;
                        const actorLabel = event.actorEmail.split('@')[0];

                        return (
                            <li key={event.id} className="flex items-start gap-2 text-sm">
                                <UserAvatar email={event.actorEmail} size="sm" className="mt-0.5 shrink-0" />
                                <div className="min-w-0 flex-1">
                                    <span className="font-medium">{actorLabel}</span>{' '}
                                    <span>{fileEventVerb(event.eventType)}</span>
                                    {isFolder && !isSameFile && (
                                        <>
                                            {' '}
                                            <span className="font-medium">{event.pathName}</span>
                                        </>
                                    )}
                                    <div className={cn('text-xs text-muted-foreground flex items-center gap-1 mt-0.5')}>
                                        <EventIcon className="h-3 w-3" />
                                        {formatTimeAgo(event.createdAt)}
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
            {watchStatus !== undefined && (
                <div className="text-sm text-muted-foreground">
                    {direct ? (
                        <>
                            <span>You&apos;re watching this</span>
                            {' · '}
                            <button
                                type="button"
                                className="underline-offset-2 hover:underline"
                                onClick={() => unwatchMutation.mutate()}
                            >
                                Stop watching
                            </button>
                        </>
                    ) : watchStatus?.viaAncestor ? (
                        <span>Watching via {watchStatus.viaAncestor.name}</span>
                    ) : (
                        <button
                            type="button"
                            className="underline-offset-2 hover:underline"
                            onClick={() => watchMutation.mutate()}
                        >
                            Watch this file
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
