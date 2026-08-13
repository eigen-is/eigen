import { formatDateTime } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import { type DrivePath, isDocumentType, isOpenable, stripEigenExtension } from '@workspace/lib/types/drive';
import { TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { DriveAccessList } from '@workspace/ui/components/drive';
import { DropdownMenu, DropdownMenuContent } from '@workspace/ui/components/dropdown-menu';
import { KebabTrigger } from '@workspace/ui/components/layout/toolbar';
import { WatchToggleButton } from '@workspace/ui/components/layout/toolbar/watch-toggle-button';
import { Download, UserRoundPlus, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLayout } from '../layout/app/layout-context.tsx';
import { useOptionalPreview } from '../preview-provider/preview-provider';
import { DriveItemMenuItems } from './drive-item-menu';
import { DrivePreview } from './drive-preview';
import { getFilePresentation } from './file-presentation';
import { RecentActivity } from './recent-activity';

type DriveDetailToolbarProps = {
    onClose?: () => void;
};

export function DriveDetailToolbar({ onClose }: DriveDetailToolbarProps) {
    const { isMobile } = useLayout();

    return (
        <div className="flex items-center w-full justify-end">
            {!isMobile && onClose && <TooltipButton onClick={onClose} tooltipText="Close" icon={X} />}
        </div>
    );
}

type DriveDetailProps = {
    path: DrivePath | null;
    onDelete?: (items: DrivePath[]) => void;
    onShareClick?: (path: DrivePath) => void;
    onDownload?: (path: DrivePath) => void;
    onItemOpen?: (path: DrivePath) => void;
    onRename?: (path: DrivePath) => void;
    onMoveTo?: (items: DrivePath[]) => void;
    onCopyTo?: (items: DrivePath[]) => void;
    onDuplicate?: (items: DrivePath[]) => void;
    onQuickLook?: (path: DrivePath) => void;
    onConvert?: (path: DrivePath, target: 'eigensheets' | 'eigendoc') => void;
    onExport?: (path: DrivePath, format: string) => void;
    onEmailCollaborators?: (path: DrivePath) => void;
    allowDelete?: boolean;
    highlightHistory?: boolean;
};

export function DriveDetail({
    path,
    onDelete,
    onShareClick,
    onDownload,
    onItemOpen,
    onRename,
    onMoveTo,
    onCopyTo,
    onDuplicate,
    onQuickLook,
    onConvert,
    onExport,
    onEmailCollaborators,
    allowDelete,
    highlightHistory,
}: DriveDetailProps) {
    const preview = useOptionalPreview();

    if (!path) return null;

    // App/chat files open in their native app; media + others go through the
    // read-only preview lightbox.
    const onHeroClick = () => {
        if (isDocumentType(path.type)) {
            onItemOpen?.(path);
        } else {
            preview?.openPreview(path, []);
        }
    };

    const canOpen = !!onItemOpen && isOpenable(path);
    const canDownload = !!onDownload && path.type === 'file';

    return (
        <div className="flex flex-col h-full bg-background">
            <div className="app-gutter flex-1 overflow-auto">
                <DrivePreview path={path} onActivate={onHeroClick} className="mb-4" />
                <h2 className="text-xl font-medium truncate overflow-hidden mb-3">{stripEigenExtension(path.name)}</h2>
                <div className="flex items-center gap-2 mb-4">
                    {canOpen && (
                        <Button
                            size="sm"
                            onClick={() => onItemOpen?.(path)}
                            className="flex-1 h-8 bg-app text-white hover:bg-app hover:opacity-90"
                        >
                            Open
                        </Button>
                    )}
                    <div className="flex items-center gap-2 ml-auto">
                        {canDownload && (
                            <TooltipButton
                                variant="outline"
                                icon={Download}
                                tooltipText="Download"
                                onClick={() => onDownload?.(path)}
                            />
                        )}
                        {onShareClick && (
                            <TooltipButton
                                variant="outline"
                                icon={UserRoundPlus}
                                tooltipText="Share"
                                onClick={() => onShareClick(path)}
                            />
                        )}
                        <WatchToggleButton ownerId={path.ownerId} mountId={path.mountId} pathId={path.id} />
                        <DropdownMenu>
                            <KebabTrigger variant="outline" />
                            <DropdownMenuContent className="w-48">
                                <DriveItemMenuItems
                                    item={path}
                                    onItemOpen={onItemOpen}
                                    onQuickLook={onQuickLook}
                                    onDownload={onDownload}
                                    onConvert={onConvert}
                                    onExport={onExport}
                                    onRename={onRename}
                                    onMoveTo={onMoveTo}
                                    onCopyTo={onCopyTo}
                                    onDuplicate={onDuplicate}
                                    onShareClick={onShareClick}
                                    onEmailCollaborators={onEmailCollaborators}
                                    onDelete={onDelete}
                                    allowDelete={allowDelete}
                                />
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
                <DetailsSection path={path} />
                <h3 className="eigen-section-label mt-6 mb-2">Shared with</h3>
                <DriveAccessList path={path} onShareClick={onShareClick} />
                <RecentActivity path={path} highlight={highlightHistory} />
            </div>
        </div>
    );
}

const EXTRA_DETAIL_HIDDEN_KEYS = new Set(['width', 'height', 'duration', 'pageCount', 'webdavProps', 'originalName']);

function DetailsSection({ path }: { path: DrivePath }) {
    const presentation = getFilePresentation(path.mimeType, path.type);
    const details = path.details;
    const extraEntries = details ? Object.entries(details).filter(([key]) => !EXTRA_DETAIL_HIDDEN_KEYS.has(key)) : [];

    return (
        <>
            <h3 className="eigen-section-label mt-2 mb-2">Details</h3>
            <dl className="text-sm space-y-1.5">
                <Row label="Type" value={presentation.label} />
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
