// One row of the Drive table: the item's icon and name, with its owner, sharing, size and date in the
// columns the container is wide enough for, and a ⋮ that opens the row menu. DriveTable draws one per
// item and hands it the listing's controller for selection, drag and menus.

import { formatDateTime } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import type { DrivePath } from '@workspace/lib/types';
import { cn } from '@workspace/ui/lib/utils';
import type { useLongPress } from '../../hooks/use-long-press';
import { ContextMenuButton } from '../context-menu';
import { UnreadDot } from '../unread-dot';
import { UserAvatar } from '../user/user-avatar';
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
    // The table shares one useLongPress, and bind(item) gives this row its touch handlers.
    longPressBind: ReturnType<typeof useLongPress<DrivePath>>['bind'];
    getItemHref?: (item: DrivePath) => string | undefined;
    onItemClick?: (item: DrivePath) => void;
    onShareClick?: (item: DrivePath) => void;
    hideOwner?: boolean;
    hideShared?: boolean;
    hideModified?: boolean;
    hideShareClick?: boolean;
    hideActions?: boolean;
    getItemDate?: (item: DrivePath) => Date | null;
    ancestorBreadcrumb?: DrivePath[];
    unreadPathIds?: ReadonlySet<string>;
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
    longPressBind,
    getItemHref,
    onItemClick,
    onShareClick,
    hideOwner = false,
    hideShared = false,
    hideModified = false,
    hideShareClick = false,
    hideActions = false,
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
    const presentation = getFilePresentation(item.mimeType, item.type, item.name);
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
                // A disabled row keeps its pointer events, so a right-click on it lands here and never opens the
                // background menu. Its other handlers below do nothing while it is disabled.
                disabled && 'opacity-40',
            )}
            onClick={(e) => {
                if (disabled) return;
                selection.handleItemClick(item.id, e);
                if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                    onItemClick?.(item);
                }
            }}
            onContextMenu={
                hideActions
                    ? (e) => {
                          // A picker row has no actions. The right-click still must not reach DriveBrowser's
                          // background menu, which would offer a new folder beside this row.
                          e.preventDefault();
                          e.stopPropagation();
                      }
                    : (e) => handleContextMenu(e, item)
            }
            {...(disabled || hideActions ? {} : longPressBind(item))}
            {...(disabled ? {} : drag.getDragProps(item))}
            {...(disabled ? {} : getDropProps(item))}
        >
            <div className="pr-2 py-1.5 flex items-center min-w-0">
                <div className="relative mr-2 flex-shrink-0">
                    {getFileIcon(item.mimeType, item.type, item.name, {
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
                        inKeyboardList
                    />
                </div>
            )}
            <div className="hidden @[800px]:flex items-center justify-end pl-2 pr-4 py-1.5 whitespace-nowrap text-xs text-muted-foreground">
                {formatFileSize(item.size)}
            </div>
            {!hideModified && (
                <div className="hidden @[600px]:flex items-center justify-end px-2 py-1.5 whitespace-nowrap text-xs text-muted-foreground">
                    {itemDate ? formatDateTime(itemDate) : 'Unknown'}
                </div>
            )}
            {!hideActions && (
                <div
                    className={
                        coarse
                            ? 'flex items-center justify-center py-1.5'
                            : 'hidden @[800px]:flex items-center justify-center py-1.5'
                    }
                >
                    <ContextMenuButton
                        onOpen={(button) => openContextMenuFromButton(button, item)}
                        className="h-7 w-7"
                    />
                </div>
            )}
        </div>
    );
}
