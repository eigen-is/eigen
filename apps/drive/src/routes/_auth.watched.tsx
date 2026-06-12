import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { getDriveItemUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { formatTimeAgo } from '@workspace/lib/date';
import { useSharedPaths, useUserWatches } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import { isFolderType, stripEigenExtension } from '@workspace/lib/types/drive';
import { fileEventVerb, type WatchedItem } from '@workspace/lib/types/file-history';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { EmptyState } from '@workspace/ui/components/layout/app/empty-state';
import { LoadingState } from '@workspace/ui/components/layout/app/loading-state';
import { getFileIcon } from '@workspace/ui/components/layout/drive/file-presentation';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { cn } from '@workspace/ui/lib/utils';
import { Bell } from 'lucide-react';

export const Route = createFileRoute('/_auth/watched')({
    component: WatchedRoute,
});

function WatchedRoute() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const userId = user!.id;

    const { data: myTeams, isLoading: isTeamsLoading } = useMyTeams();
    const teams = myTeams?.map((t) => teamOwnerId(t.id)) ?? [];

    // Watches on alice's share live in alice's mount; include her ownerId so those watches
    // are fetched. Wait for the share list so the owner set is complete on the first fetch.
    const { data: sharedWithMe, isLoading: isSharedLoading } = useSharedPaths(userId, 'with-me');
    const ownerIds = isSharedLoading
        ? []
        : [...new Set([userId, ...teams, ...(sharedWithMe?.map((p) => p.ownerId) ?? [])])];

    const watches = useUserWatches(ownerIds);

    const items: WatchedItem[] = [...watches].sort((a, b) => {
        const aDate = a.lastEventAt ?? a.watchedAt;
        const bDate = b.lastEventAt ?? b.watchedAt;
        return bDate.getTime() - aDate.getTime();
    });

    const onRowActivate = (item: WatchedItem) => {
        if (isFolderType(item.type)) {
            navigate({
                to: '/fs/$ownerId/$mountId/$pathId',
                params: { ownerId: item.ownerId, mountId: item.mountId, pathId: item.pathId },
            });
            return;
        }
        const ref = {
            id: item.pathId,
            ownerId: item.ownerId,
            mountId: item.mountId,
            name: item.name,
            type: item.type,
            mimeType: item.mimeType,
        };
        const url = getDriveItemUrl(ref);
        if (url) {
            window.location.href = url;
        } else {
            navigate({
                to: '/fs/$ownerId/$mountId/$pathId',
                params: { ownerId: item.ownerId, mountId: item.mountId, pathId: item.pathId },
            });
        }
    };

    if (isTeamsLoading || isSharedLoading) return <LoadingState />;

    const gridCols = 'grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_25%]';

    return (
        <ColumnLayout>
            <Column
                id="watched"
                width="flex"
                toolbar={
                    <div className="flex items-center w-full">
                        <ToolbarTitle>Watched</ToolbarTitle>
                    </div>
                }
            >
                {items.length === 0 ? (
                    <EmptyState message="No watched items" icon={<Bell className="h-10 w-10" />} />
                ) : (
                    <div className="flex-1 overflow-auto text-sm">
                        <div className={cn('grid', gridCols, 'border-b')}>
                            <div className="text-muted-foreground h-10 px-2 flex items-center font-medium">Name</div>
                            <div className="text-muted-foreground h-10 px-2 hidden sm:flex items-center font-medium">
                                Last activity
                            </div>
                        </div>
                        {items.map((item) => (
                            <div
                                key={`${item.ownerId}:${item.mountId}:${item.pathId}`}
                                className={cn(
                                    'grid',
                                    gridCols,
                                    'border-b transition-colors eigen-list-item cursor-pointer',
                                )}
                                onClick={() => onRowActivate(item)}
                            >
                                <div className="px-2 py-1.5 flex items-center min-w-0">
                                    {getFileIcon(item.mimeType, item.type, {
                                        className: 'h-4 w-4 mr-2 text-muted-foreground flex-shrink-0',
                                        ...(isFolderType(item.type) ? { fill: 'var(--app-drive-light-color)' } : {}),
                                    })}
                                    <span className="truncate">{stripEigenExtension(item.name)}</span>
                                </div>
                                <div className="hidden sm:flex items-center px-2 py-1.5 text-muted-foreground whitespace-nowrap">
                                    {item.lastEventType && item.lastEventAt
                                        ? `${fileEventVerb(item.lastEventType)} ${formatTimeAgo(item.lastEventAt)}`
                                        : formatTimeAgo(item.watchedAt)}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </Column>
        </ColumnLayout>
    );
}
