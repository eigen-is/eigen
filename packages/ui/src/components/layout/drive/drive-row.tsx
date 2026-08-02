import { formatDateTime } from '@workspace/lib/date';
import type { DrivePath } from '@workspace/lib/types';
import { cn } from '@workspace/ui/lib/utils';
import { MoreVertical } from 'lucide-react';
import { UnreadDot } from '../unread-dot';
import { UserAvatar } from '../user-avatar';
import { DriveItemNameLink } from './drive-item-name-link';
import { DriveShareSummary } from './drive-share-summary';
import { getFileIcon, getFilePresentation } from './file-presentation';
import type { useDriveItemController } from './use-drive-item-controller';

type DriveRowProps = {
    item: DrivePath;
    index: number;
    isActive: boolean;
    isSelected: boolean;
    disabled: boolean;
    gridCols: string;
    coarse: boolean;
    controller: ReturnType<typeof useDriveItemController>;
    getItemHref?: (item: DrivePath) => string | undefined;
    onItemClick?: (item: DrivePath) => void;
    onShareClick?: (item: DrivePath) => void;
    hideOwner?: boolean;
    hideShared?: boolean;
    hideModified?: boolean;
    hideShareClick?: boolean;
    getItemDate?: (item: DrivePath) => Date | null;
    ancestorBreadcrumb?: DrivePath[];
    unreadPathIds?: Set<string>;
};

export function DriveRow({
    item,
    index,
    isActive,
    isSelected,
    disabled,
    gridCols,
    coarse,
    controller,
    getItemHref,
    onItemClick,
    onShareClick,
    hideOwner = false,
    hideShared = false,
    hideModified = false,
    hideShareClick = false,
    getItemDate = (i) => i.updatedAt,
    ancestorBreadcrumb,
    unreadPathIds,
}: DriveRowProps) {
    const {
        selection,
        drag,
        handleContextMenu,
        openContextMenuFromButton,
        isValidFolderDrop,
        getDropProps,
        dragOverItemId,
    } = controller;
    const presentation = getFilePresentation(item.mimeType, item.type);
    const itemDate = getItemDate(item);

    return (
        <div
            role="row"
            aria-rowindex={index + 1}
            className={cn(
                'grid border-b transition-colors eigen-list-item app-gutter-x',
                gridCols,
                isActive && 'eigen-list-item-active',
                isSelected && 'eigen-list-item-selected',
                dragOverItemId === item.id && isValidFolderDrop(item) && 'bg-accent',
                disabled && 'opacity-40 pointer-events-none',
            )}
            onClick={(e) => {
                selection.handleItemClick(item.id, e);
                if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                    onItemClick?.(item);
                }
            }}
            onContextMenu={(e) => handleContextMenu(e, item)}
            {...drag.getDragProps(item)}
            {...getDropProps(item)}
        >
            <div className="pr-2 py-1.5 flex items-center min-w-0">
                <div className="relative mr-2 flex-shrink-0">
                    {getFileIcon(item.mimeType, item.type, {
                        className: 'h-4 w-4',
                        style: { color: presentation.colorVar, fill: presentation.fillColorVar },
                    })}
                    {unreadPathIds?.has(item.id) && <UnreadDot />}
                </div>
                <DriveItemNameLink name={item.name} href={getItemHref?.(item)} />
            </div>
            {!hideOwner && (
                <div className="hidden @[800px]:flex items-center justify-center px-2 py-1.5">
                    <div className="-my-0.5">
                        <UserAvatar userId={item.ownerId} size="sm" tooltip />
                    </div>
                </div>
            )}
            {!hideShared && (
                <div className="hidden @[800px]:flex items-center justify-center px-2 py-1.5 group">
                    <DriveShareSummary
                        path={item}
                        onClick={hideShareClick ? undefined : () => onShareClick?.(item)}
                        showIconOnHover={!hideShareClick}
                        ancestorBreadcrumb={ancestorBreadcrumb}
                    />
                </div>
            )}
            {!hideModified && (
                <div className="hidden @[600px]:flex items-center justify-end pl-2 pr-4 py-1.5 whitespace-nowrap text-xs text-muted-foreground">
                    {itemDate ? formatDateTime(itemDate) : 'Unknown'}
                </div>
            )}
            <div className={cn(coarse ? 'flex' : 'hidden @[800px]:flex', 'items-center justify-center py-1.5')}>
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        openContextMenuFromButton(e.currentTarget, item);
                    }}
                    className="h-7 w-7 rounded hover:bg-accent flex items-center justify-center text-muted-foreground"
                    aria-label="More actions"
                >
                    <MoreVertical className="h-4 w-4" />
                </button>
            </div>
        </div>
    );
}
