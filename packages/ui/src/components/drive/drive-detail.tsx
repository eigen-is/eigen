// The detail column of a Drive view: the selected item's preview, its Open, Download, Share and Watch
// buttons, a ⋮ with the item's whole menu, and its details, sharing and recent activity. DriveLayout
// draws it beside the list.

import { getDriveItemUrl } from '@workspace/lib/api';
import { formatDateTime } from '@workspace/lib/date';
import { useBreadcrumb } from '@workspace/lib/drive';
import { formatFileSize } from '@workspace/lib/format';
import { useResolvedUser } from '@workspace/lib/public';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isDocumentType, sharedChainHead, stripEigenExtension } from '@workspace/lib/types/drive';
import type { DriveActionId } from '@workspace/lib/types/drive-actions';
import type { FileActionId } from '@workspace/lib/types/file-subject';
import { Button } from '@workspace/ui/components/button';
import { DropdownMenu, DropdownMenuContent } from '@workspace/ui/components/dropdown-menu';
import { KebabTrigger } from '@workspace/ui/components/layout/toolbar';
import { WatchToggleButton } from '@workspace/ui/components/layout/toolbar/watch-toggle-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLayout } from '../layout/app/layout-context';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { DriveAccessList } from './drive-access-list';
import type { DriveActionRunner } from './drive-action-runner';
import { DriveItemMenuItems } from './drive-item-menu';
import { useMountLabel } from './drive-mount-list';
import { DrivePreview } from './drive-preview';
import { getFilePresentation } from './file-presentation';
import { RecentActivity } from './recent-activity';
import { useDriveFileActionRunner } from './use-drive-file-action-runner';

type DriveDetailToolbarProps = {
    onClose: () => void;
};

export function DriveDetailToolbar({ onClose }: DriveDetailToolbarProps) {
    const { isMobile } = useLayout();

    return (
        <div className="flex items-center w-full justify-end">
            {!isMobile && <TooltipButton onClick={onClose} tooltipText="Close" icon={X} />}
        </div>
    );
}

type DriveDetailProps = {
    path: DrivePath | null;
    // The listing this item sits in, in its display order: Quick preview pages through it.
    siblings: readonly DrivePath[];
    actions: DriveActionRunner;
};

export function DriveDetail({ path, siblings, actions }: DriveDetailProps) {
    const runner = useDriveFileActionRunner(path, siblings, actions.capabilities.canWrite);

    if (!path) return null;

    // The buttons draw the rows the view offers for this item, with the rows' own labels and icons.
    const driveAction = (id: DriveActionId) => actions.actionsFor([path]).find((action) => action.id === id);
    const fileAction = (id: FileActionId) => runner.actions.find((action) => action.id === id);
    const open = driveAction('open');
    const share = driveAction('share');
    const quickLook = fileAction('quick-look');
    const download = fileAction('download');

    // A document opens in its own app; anything the registry previews opens in the quick look.
    const onHeroClick = () => {
        if (isDocumentType(path.type)) actions.run('open', [path]);
        else if (quickLook) runner.run(quickLook);
    };

    return (
        <div className="flex flex-col h-full bg-background">
            <div className="app-gutter flex-1 overflow-auto">
                <DrivePreview path={path} onActivate={onHeroClick} className="mb-4" />
                <h2 className="text-xl font-medium truncate overflow-hidden mb-3">{stripEigenExtension(path.name)}</h2>
                <div className="flex items-center gap-2 mb-4">
                    {open && (
                        <Button
                            size="sm"
                            onClick={() => actions.run(open.id, [path])}
                            className="flex-1 h-8 bg-app text-white hover:bg-app hover:opacity-90"
                        >
                            {open.label}
                        </Button>
                    )}
                    <div className="flex items-center gap-2 ml-auto">
                        {download && (
                            <TooltipButton
                                icon={download.icon}
                                tooltipText={download.label}
                                onClick={() => runner.run(download)}
                            />
                        )}
                        {share && (
                            <TooltipButton
                                icon={share.icon}
                                tooltipText={share.label}
                                onClick={() => actions.run(share.id, [path])}
                            />
                        )}
                        <WatchToggleButton ownerId={path.ownerId} mountId={path.mountId} pathId={path.id} />
                        <DropdownMenu>
                            <KebabTrigger />
                            <DropdownMenuContent className="w-48">
                                <DriveItemMenuItems items={[path]} actions={actions} runner={runner} />
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
                <DetailsSection path={path} />
                <h3 className="eigen-section-label mt-6 mb-2">Shared with</h3>
                <DriveAccessList path={path} onShareClick={share && (() => actions.run(share.id, [path]))} />
                <RecentActivity path={path} />
            </div>
            {runner.dialogs}
        </div>
    );
}

const EXTRA_DETAIL_HIDDEN_KEYS = new Set(['width', 'height', 'duration', 'pageCount', 'webdavProps', 'originalName']);

function DetailsSection({ path }: { path: DrivePath }) {
    const presentation = getFilePresentation(path.mimeType, path.type, path.name);
    const details = path.details;
    const extraEntries = details ? Object.entries(details).filter(([key]) => !EXTRA_DETAIL_HIDDEN_KEYS.has(key)) : [];

    // The parent's chain, the one the folder view reads. Cut short above the viewer's reach, it no longer starts at
    // the drive, so the owner stands in for it.
    const {
        data: chain = [],
        isPending,
        isError,
    } = useBreadcrumb(path.ownerId, path.mountId, path.parentId ?? undefined);
    const mountLabel = useMountLabel(path.ownerId, path.mountId);
    const { displayName: ownerName } = useResolvedUser({ userId: path.ownerId });
    const fromRoot = chain.length > 0 && !sharedChainHead(chain);
    const location = [
        fromRoot ? mountLabel : ownerName,
        ...chain.slice(fromRoot ? 1 : 0).map((folder) => stripEigenExtension(folder.name)),
    ].join(' › ');
    const parent = chain.at(-1);
    const parentHref = parent && getDriveItemUrl(parent);

    return (
        <>
            <h3 className="eigen-section-label mt-2 mb-2">Details</h3>
            <dl className="text-sm space-y-1.5">
                <Row label="Type" value={presentation.label} />
                {/* Drawn empty while the chain loads, so the rows below don't jump when it arrives. */}
                {path.parentId && !isError && (
                    <Row
                        label="Location"
                        value={
                            !isPending && (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        {parentHref ? (
                                            <a href={parentHref} className="hover:underline">
                                                {location}
                                            </a>
                                        ) : (
                                            <span>{location}</span>
                                        )}
                                    </TooltipTrigger>
                                    <TooltipContent>{location}</TooltipContent>
                                </Tooltip>
                            )
                        }
                    />
                )}
                <Row label="Size" value={formatFileSize(path.size)} />
                {path.createdAt && <Row label="Created" value={formatDateTime(path.createdAt)} />}
                {details?.width && details?.height && (
                    <Row label="Dimensions" value={`${details.width} × ${details.height}`} />
                )}
                {details?.duration && (
                    <Row
                        label="Duration"
                        value={`${Math.floor(details.duration / 60)}:${String(Math.floor(details.duration % 60)).padStart(2, '0')}`}
                    />
                )}
                {details?.pageCount && <Row label="Pages" value={details.pageCount} />}
                {extraEntries.map(([key, value]) => (
                    <Row key={key} label={<span className="capitalize">{key}</span>} value={String(value)} />
                ))}
            </dl>
        </>
    );
}

function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
    return (
        <div className="flex justify-between items-baseline gap-4">
            <dt className="text-muted-foreground shrink-0">{label}</dt>
            <dd className="text-right truncate min-w-0">{value}</dd>
        </div>
    );
}
