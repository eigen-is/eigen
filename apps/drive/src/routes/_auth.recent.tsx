// Drive's Recent page: the files and folders the viewer opened or was notified about, wherever they live,
// each once, with the time of that last activity, and under each name what last happened to it, such as
// "Mark commented · 2h ago". It opens newest first every time and keeps its own sort, because the shared view
// preference could open it alphabetically. The rows belong to many owners, so the page is read-only, and a
// selected row's ?pid=&uid=&mid= opens its detail beside the list.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { formatTimeAgo } from '@workspace/lib/date';
import { DEFAULT_MOUNT_ID, usePathInfo, useRecentPaths } from '@workspace/lib/drive';
import { usePublicUsers } from '@workspace/lib/public';
import type { DrivePath, DriveSearchParams, DriveSort } from '@workspace/lib/types/drive';
import { describeFileEvent } from '@workspace/lib/types/file-history';
import { EmptyState, LoadingState } from '@workspace/ui';
import { DRIVE_CAPABILITIES } from '@workspace/ui/components/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/drive/drive-layout';
import { useDriveListRoute } from '@workspace/ui/components/drive/use-drive-list-route';
import { useMemo, useState } from 'react';

export const Route = createFileRoute('/_auth/recent')({
    component: RecentRoute,
    validateSearch: (search: Record<string, unknown>): DriveSearchParams => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        const uid = typeof search.uid === 'string' ? search.uid : undefined;
        const mid = typeof search.mid === 'string' ? search.mid : undefined;
        return { pid, uid, mid };
    },
});

function RecentRoute() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { pid, uid, mid } = Route.useSearch();

    const { data: recentPaths = [], isLoading, error } = useRecentPaths();
    const { data: selectedPath = null } = usePathInfo(uid || '', mid || DEFAULT_MOUNT_ID, pid || '');
    const [sort, setSort] = useState<DriveSort>({ key: 'modified', dir: 'desc' });
    const recentById = useMemo(() => new Map(recentPaths.map((path) => [path.id, path])), [recentPaths]);
    const actorEmails = useMemo(
        () => [...new Set(recentPaths.flatMap((path) => (path.latestEvent ? [path.latestEvent.actorEmail] : [])))],
        [recentPaths],
    );
    const actors = usePublicUsers(actorEmails);

    // The line names its file's own event, so its words leave the name out. Those words name no one else, so only
    // the actor is looked up.
    const activityLine = (path: DrivePath) => {
        const event = recentById.get(path.id)?.latestEvent;
        if (!event) return null;
        const actor =
            event.actorUserId === user?.id ? 'You' : actors[event.actorEmail]?.name || event.actorEmail.split('@')[0];
        return `${actor} ${describeFileEvent(event, 'own').action} · ${formatTimeAgo(event.createdAt)}`;
    };

    const { onRowSelect, onRowActivate, onQuickLook } = useDriveListRoute({
        items: recentPaths,
        capabilities: DRIVE_CAPABILITIES.readOnly,
        onOpenFolder: (path: DrivePath) =>
            navigate({
                to: '/fs/$ownerId/$mountId/$pathId',
                params: { ownerId: path.ownerId, mountId: path.mountId, pathId: path.id },
            }),
        onSelectItem: (path: DrivePath) =>
            navigate({
                to: Route.fullPath,
                search: { pid: path.id, uid: path.ownerId, mid: path.mountId },
            }),
    });

    const handleBack = () => {
        navigate({ to: Route.fullPath, search: { pid: undefined, uid: undefined, mid: undefined } });
    };

    if (isLoading) return <LoadingState />;

    return (
        <DriveLayout
            pid={pid}
            selectedPath={selectedPath}
            ownerId={uid || user?.id || ''}
            mountId={mid || DEFAULT_MOUNT_ID}
            folderContents={recentPaths}
            isLoading={false}
            error={error}
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            onBackToList={handleBack}
            capabilities={DRIVE_CAPABILITIES.readOnly}
            title="Recent files"
            onQuickLook={onQuickLook}
            emptyState={<EmptyState message="Files you open or get notified about will appear here." />}
            sort={sort}
            onSortChange={setSort}
            dateLabel="Last activity"
            getItemDate={(path) => recentById.get(path.id)?.lastActivityAt ?? null}
            getItemActivity={activityLine}
        />
    );
}
