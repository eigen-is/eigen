import { getDriveItemThumbnail } from '@workspace/lib/api';
import type { DrivePath } from '@workspace/lib/types/drive';
import { cn } from '@workspace/ui/lib/utils';
import { MoreVertical } from 'lucide-react';
import { useState } from 'react';
import { useLongPress } from '../../../hooks/use-long-press';
import { UnreadDot } from '../unread-dot';
import { DriveItemNameLink } from './drive-item-name-link';
import { getFileIcon, getFilePresentation } from './file-presentation';
import type { useDriveItemController } from './use-drive-item-controller';

type DriveTileProps = {
    item: DrivePath;
    isActive: boolean;
    isSelected: boolean;
    disabled: boolean;
    controller: ReturnType<typeof useDriveItemController>;
    getItemHref?: (item: DrivePath) => string | undefined;
    onItemClick?: (item: DrivePath) => void;
    unreadPathIds?: Set<string>;
};

export function DriveTile({
    item,
    isActive,
    isSelected,
    disabled,
    controller,
    getItemHref,
    onItemClick,
    unreadPathIds,
}: DriveTileProps) {
    const {
        selection,
        drag,
        handleContextMenu,
        openContextMenuFromButton,
        openContextMenuAt,
        isValidFolderDrop,
        getDropProps,
        dragOverItemId,
    } = controller;
    const presentation = getFilePresentation(item.mimeType, item.type);
    const { showThumbnail, thumbnailUrl } = getDriveItemThumbnail(item);
    const [thumbFailed, setThumbFailed] = useState(false);
    const longPress = useLongPress((x, y) => openContextMenuAt(item, x, y), { disabled });

    return (
        <div
            onClick={(e) => {
                selection.handleItemClick(item.id, e);
                if (!e.shiftKey && !e.metaKey && !e.ctrlKey) onItemClick?.(item);
            }}
            onContextMenu={(e) => handleContextMenu(e, item)}
            {...longPress}
            {...drag.getDragProps(item)}
            {...getDropProps(item)}
            className={cn(
                'group relative flex flex-col rounded-lg border overflow-hidden cursor-pointer transition-colors',
                'eigen-tile',
                isActive && 'eigen-tile-active',
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
                    getFileIcon(item.mimeType, item.type, {
                        className: 'size-10',
                        style: { color: presentation.colorVar },
                    })
                )}
            </div>
            <div className="flex items-center gap-1 px-2 py-1.5 min-w-0">
                <span className="relative flex-shrink-0">
                    {getFileIcon(item.mimeType, item.type, {
                        className: 'h-4 w-4',
                        style: { color: presentation.colorVar },
                    })}
                    {unreadPathIds?.has(item.id) && <UnreadDot />}
                </span>
                <DriveItemNameLink name={item.name} href={getItemHref?.(item)} className="text-xs" />
                <button
                    type="button"
                    aria-label="More actions"
                    onClick={(e) => {
                        e.stopPropagation();
                        openContextMenuFromButton(e.currentTarget, item);
                    }}
                    className="ml-auto flex-shrink-0 h-6 w-6 rounded hover:bg-accent flex items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100"
                >
                    <MoreVertical className="h-4 w-4" />
                </button>
            </div>
        </div>
    );
}
