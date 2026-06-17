import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { getDriveItemUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { formatTimeAgo } from '@workspace/lib/date';
import { DEFAULT_MOUNT_ID, usePathInfo, useSharedPaths, useUserWatches } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import {
    type DriveItemRef,
    type DriveSearchParams,
    isDocumentType,
    isFolderType,
    stripEigenExtension,
} from '@workspace/lib/types/drive';
import { fileEventSummary, type WatchedItem } from '@workspace/lib/types/file-history';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { EmptyState } from '@workspace/ui/components/layout/app/empty-state';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context.tsx';
import { LoadingState } from '@workspace/ui/components/layout/app/loading-state';
import { DriveDetail, DriveDetailToolbar } from '@workspace/ui/components/layout/drive/drive-detail';
import { getFileIcon } from '@workspace/ui/components/layout/drive/file-presentation';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { cn } from '@workspace/ui/lib/utils';
import { Bell } from 'lucide-react';

export const Route = createFileRoute('/_auth/watched')({
    component: WatchedRoute,
    validateSearch: (search: Record<string, unknown>): DriveSearchParams => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        const uid = typeof search.uid === 'string' ? search.uid : undefined;
        const mid = typeof search.mid === 'string' ? search.mid : undefined;
        return { pid, uid, mid };
    },
});

function WatchedRoute() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const userId = user!.id;
    const { pid, uid, mid } = Route.useSearch();
    const { isMobile } = useLayout();

    const { data: myTeams, isLoading: isTeamsLoading } = useMyTeams();
    const teams = myTeams?.map((t) => teamOwnerId(t.id)) ?? [];

    // Watches on alice's share live in alice's mount; include her ownerId so those watches
    // are fetched. Wait for the share list so the owner set is complete on the first fetch.
    const { data: sharedWithMe, isLoading: isSharedLoading } = useSharedPaths(userId, 'with-me');
    const ownerIds = isSharedLoading
        ? []
        : [...new Set([userId, ...teams, ...(sharedWithMe?.map((p) => p.ownerId) ?? [])])];

    const watches = useUserWatches(ownerIds);
    const { data: selectedPath = null } = usePathInfo(uid || userId, mid || DEFAULT_MOUNT_ID, pid);

    const isActive = (item: WatchedItem) => item.pathId === pid && item.ownerId === uid && item.mountId === mid;

    // WatchedItem is a lightweight cross-owner row; the open helpers take the shared
    // DriveItemRef shape so the same logic serves a clicked row and the panel's Open button.
    const watchedRef = (item: WatchedItem): DriveItemRef => ({
        id: item.pathId,
        ownerId: item.ownerId,
        mountId: item.mountId,
        name: item.name,
        type: item.type,
        mimeType: item.mimeType,
    });

    const openItem = (ref: DriveItemRef) => {
        if (isFolderType(ref.type)) {
            navigate({
                to: '/fs/$ownerId/$mountId/$pathId',
                params: { ownerId: ref.ownerId, mountId: ref.mountId, pathId: ref.id },
            });
            return;
        }
        const url = getDriveItemUrl(ref);
        if (url) {
            window.location.href = url;
        } else {
            navigate({
                to: '/fs/$ownerId/$mountId/$pathId',
                params: { ownerId: ref.ownerId, mountId: ref.mountId, pathId: ref.id },
            });
        }
    };

    // Mirror the drive list's two-stage interaction: a click selects (opens the properties
    // panel); a click on the already-selected row activates it. On mobile, folders and
    // documents open straight away — matching the fs/shared/mime views.
    const handleRowClick = (item: WatchedItem) => {
        if (isActive(item) || (isMobile && (isFolderType(item.type) || isDocumentType(item.type)))) {
            openItem(watchedRef(item));
            return;
        }
        navigate({
            to: Route.fullPath,
            search: { pid: item.pathId, uid: item.ownerId, mid: item.mountId },
        });
    };

    const handleBack = () => {
        navigate({ to: Route.fullPath, search: { pid: undefined, uid: undefined, mid: undefined } });
    };

    if (isTeamsLoading || isSharedLoading) return <LoadingState />;

    const items: WatchedItem[] = [...watches].sort((a, b) => {
        const aDate = a.lastEventAt ?? a.watchedAt;
        const bDate = b.lastEventAt ?? b.watchedAt;
        return bDate.getTime() - aDate.getTime();
    });

    const showDetail = items.some(isActive);
    const gridCols = 'grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_25%]';

    return (
        <ColumnLayout mobileColumn={showDetail ? 'detail' : 'list'}>
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
                                role="button"
                                tabIndex={0}
                                className={cn(
                                    'grid',
                                    gridCols,
                                    'border-b transition-colors eigen-list-item cursor-pointer',
                                    isActive(item) && 'eigen-list-item-active',
                                )}
                                onClick={() => handleRowClick(item)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        handleRowClick(item);
                                    }
                                }}
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
                                        ? `${fileEventSummary(item.lastEventType)} ${formatTimeAgo(item.lastEventAt)}`
                                        : formatTimeAgo(item.watchedAt)}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </Column>
            {showDetail && (
                <Column
                    id="detail"
                    width={isMobile ? 'flex' : '400px'}
                    onBack={handleBack}
                    toolbar={<DriveDetailToolbar onClose={handleBack} />}
                >
                    <DriveDetail path={selectedPath} onItemOpen={openItem} />
                </Column>
            )}
        </ColumnLayout>
    );
}
