// One tile of the Drive grid: the item's thumbnail or icon, its name and a ⋮ that opens the row menu.
// DriveGrid draws one per item and hands it the listing's controller for selection, drag and menus.

import { getDriveItemThumbnail } from '@workspace/lib/api';
import type { DrivePath } from '@workspace/lib/types/drive';
import { cn, HOVER_REVEAL_CLASS } from '@workspace/ui/lib/utils';
import { useState } from 'react';
import type { useLongPress } from '../../hooks/use-long-press';
import { ContextMenuButton } from '../context-menu';
import { UnreadDot } from '../unread-dot';
import { DriveItemNameLink } from './drive-item-name-link';
import { getFileIcon, getFilePresentation } from './file-presentation';
import type { useDriveItemController } from './use-drive-item-controller';

type DriveTileProps = {
    item: DrivePath;
    // The open tile, such as the one whose details show beside the grid.
    isActive: boolean;
    isCursor: boolean;
    isSelected: boolean;
    disabled: boolean;
    controller: ReturnType<typeof useDriveItemController>;
    // The grid shares one useLongPress, and bind(item) gives this tile its touch handlers.
    longPressBind: ReturnType<typeof useLongPress<DrivePath>>['bind'];
    getItemHref?: (item: DrivePath) => string | undefined;
    onItemClick?: (item: DrivePath) => void;
    unreadPathIds?: ReadonlySet<string>;
};

export function DriveTile({
    item,
    isActive,
    isCursor,
    isSelected,
    disabled,
    controller,
    longPressBind,
    getItemHref,
    onItemClick,
    unreadPathIds,
}: DriveTileProps) {
    const {
        selection,
        drag,
        handleContextMenu,
        openContextMenuBelow,
        isValidFolderDrop,
        getDropProps,
        dragOverItemId,
    } = controller;
    const presentation = getFilePresentation(item.mimeType, item.type, item.name);
    const { showThumbnail, thumbnailUrl } = getDriveItemThumbnail(item);
    const [thumbFailed, setThumbFailed] = useState(false);

    return (
        <div
            onClick={(e) => {
                selection.handleItemClick(item.id, e);
                if (!e.shiftKey && !e.metaKey && !e.ctrlKey) onItemClick?.(item);
            }}
            onContextMenu={(e) => handleContextMenu(e, item)}
            {...(disabled ? {} : longPressBind(item))}
            {...drag.getDragProps(item)}
            {...getDropProps(item)}
            className={cn(
                'group relative flex flex-col rounded-lg border overflow-hidden cursor-pointer transition-colors',
                'eigen-tile',
                isActive && 'eigen-tile-active',
                isCursor && 'eigen-tile-cursor',
                isSelected && 'eigen-tile-selected',
                dragOverItemId === item.id && isValidFolderDrop(item) && 'ring-2 ring-primary',
                disabled && 'opacity-40 pointer-events-none',
            )}
        >
            <div
                className="relative aspect-[4/3] w-full flex items-center justify-center"
                style={{ backgroundColor: presentation.softColorVar }}
            >
                {showThumbnail && thumbnailUrl && !thumbFailed ? (
                    <img
                        src={thumbnailUrl}
                        alt={item.name}
                        loading="lazy"
                        onError={() => setThumbFailed(true)}
                        className="absolute inset-0 w-full h-full object-cover"
                    />
                ) : (
                    getFileIcon(item.mimeType, item.type, item.name, {
                        className: 'size-10',
                        style: { color: presentation.colorVar },
                    })
                )}
            </div>
            <div className="flex items-center gap-1 px-2 py-1.5 min-w-0">
                <span className="relative flex-shrink-0">
                    {getFileIcon(item.mimeType, item.type, item.name, {
                        className: 'h-4 w-4',
                        style: { color: presentation.colorVar },
                    })}
                    {unreadPathIds?.has(item.id) && <UnreadDot />}
                </span>
                <DriveItemNameLink name={item.name} href={getItemHref?.(item)} className="text-xs" />
                <ContextMenuButton
                    onOpen={(button) => openContextMenuBelow(button, item)}
                    className={cn(HOVER_REVEAL_CLASS, 'ml-auto flex-shrink-0 h-6 w-6')}
                />
            </div>
        </div>
    );
}
