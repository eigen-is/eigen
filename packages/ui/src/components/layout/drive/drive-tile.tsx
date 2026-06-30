import { getDriveThumbnailUrl } from '@workspace/lib/api';
import { stripEigenExtension } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { cn } from '@workspace/ui/lib/utils';
import { MoreVertical } from 'lucide-react';
import type React from 'react';
import { getFileIcon, getFilePresentation } from './file-presentation';

type DriveTileProps = {
    item: DrivePath;
    isActive: boolean;
    isSelected: boolean;
    disabled?: boolean;
    href?: string;
    onClick: (e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
    onMenuButton: (button: HTMLElement) => void;
    dragProps?: React.HTMLAttributes<HTMLDivElement>;
};

export function DriveTile({
    item,
    isActive,
    isSelected,
    disabled,
    onClick,
    onContextMenu,
    onMenuButton,
    dragProps,
}: DriveTileProps) {
    const presentation = getFilePresentation(item.mimeType, item.type);
    const isImage = item.mimeType.startsWith('image/');
    const isVideo = item.mimeType.startsWith('video/');
    const showThumb = (isImage || isVideo) && !!item.thumbnail;
    const thumbUrl = item.thumbnail
        ? `${getDriveThumbnailUrl(item.ownerId, item.mountId, item.thumbnail)}?v=${item.updatedAt.getTime()}`
        : undefined;

    return (
        <div
            onClick={onClick}
            onContextMenu={onContextMenu}
            {...dragProps}
            className={cn(
                'group relative flex flex-col rounded-lg border overflow-hidden cursor-pointer transition-colors',
                'eigen-list-item',
                isActive && 'eigen-list-item-active',
                isSelected && 'eigen-list-item-selected ring-2 ring-ring',
                disabled && 'opacity-40 pointer-events-none',
            )}
        >
            <div
                className="relative aspect-[4/3] w-full flex items-center justify-center"
                style={{ backgroundColor: presentation.softColorVar }}
            >
                {showThumb && thumbUrl ? (
                    <img
                        src={thumbUrl}
                        alt={item.name}
                        loading="lazy"
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
                <span className="flex-shrink-0">
                    {getFileIcon(item.mimeType, item.type, {
                        className: 'h-4 w-4',
                        style: { color: presentation.colorVar },
                    })}
                </span>
                <span className="truncate text-xs">{stripEigenExtension(item.name)}</span>
                <button
                    type="button"
                    aria-label="More actions"
                    onClick={(e) => {
                        e.stopPropagation();
                        onMenuButton(e.currentTarget);
                    }}
                    className="ml-auto flex-shrink-0 h-6 w-6 rounded hover:bg-accent flex items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100"
                >
                    <MoreVertical className="h-4 w-4" />
                </button>
            </div>
        </div>
    );
}
