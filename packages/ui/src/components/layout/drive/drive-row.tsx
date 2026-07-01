import { formatDateTime } from '@workspace/lib/date';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types';
import { cn } from '@workspace/ui/lib/utils';
import { MoreVertical } from 'lucide-react';
import type React from 'react';
import { UnreadDot } from '../unread-dot';
import { UserAvatar } from '../user-avatar';
import { DriveShareSummary } from './drive-share-summary';
import { getFilePresentation } from './file-presentation';
import type { useDriveItemController } from './use-drive-item-controller';

type DriveRowProps = {
    item: DrivePath;
    index: number;
    isActive: boolean;
    isSelected: boolean;
    disabled: boolean;
    gridCols: string;
    controller: ReturnType<typeof useDriveItemController>;
    getFileIcon?: (mimeType: string, type: string, props?: Record<string, unknown>) => React.ReactNode;
    getItemHref?: (item: DrivePath) => string | undefined;
    onItemClick?: (item: DrivePath) => void;
    onShareClick?: (item: DrivePath) => void;
    hideOwner?: boolean;
    hideModified?: boolean;
    hideShareClick?: boolean;
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
    controller,
    getFileIcon,
    getItemHref,
    onItemClick,
    onShareClick,
    hideOwner = false,
    hideModified = false,
    hideShareClick = false,
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
    const itemHref = getItemHref?.(item);
    const presentation = getFilePresentation(item.mimeType, item.type);

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
                    {getFileIcon?.(item.mimeType, item.type, {
                        className: 'h-4 w-4',
                        style: { color: presentation.colorVar, fill: presentation.fillColorVar },
                    })}
                    {unreadPathIds?.has(item.id) && <UnreadDot />}
                </div>
                {itemHref ? (
                    <a
                        href={itemHref}
                        className="truncate"
                        draggable={false}
                        tabIndex={-1}
                        onClick={(e) => {
                            if (e.metaKey || e.ctrlKey) {
                                e.stopPropagation();
                                return;
                            }
                            e.preventDefault();
                        }}
                        onAuxClick={(e) => {
                            if (e.button === 1) e.stopPropagation();
                        }}
                    >
                        {stripEigenExtension(item.name)}
                    </a>
                ) : (
                    <span className="truncate">{stripEigenExtension(item.name)}</span>
                )}
            </div>
            {!hideOwner && (
                <div className="hidden @[800px]:flex items-center justify-center px-2 py-1.5">
                    <div className="-my-0.5">
                        <UserAvatar userId={item.ownerId} size="sm" tooltip />
                    </div>
                </div>
            )}
            <div className="hidden @[800px]:flex items-center justify-center px-2 py-1.5 group">
                <DriveShareSummary
                    path={item}
                    onClick={hideShareClick ? undefined : () => onShareClick?.(item)}
                    showIconOnHover={!hideShareClick}
                    ancestorBreadcrumb={ancestorBreadcrumb}
                />
            </div>
            {!hideModified && (
                <div className="hidden @[600px]:flex items-center justify-end pl-2 pr-4 py-1.5 whitespace-nowrap text-xs text-muted-foreground">
                    {item.updatedAt ? formatDateTime(item.updatedAt) : 'Unknown'}
                </div>
            )}
            <div className="hidden @[800px]:flex items-center justify-center py-1.5">
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
