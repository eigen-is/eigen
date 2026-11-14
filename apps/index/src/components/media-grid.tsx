// A grid of images and videos inside a blog post or Support article, which the article's markdown declares as a
// media block. Each item is a button with a thumbnail, a play mark on a video, and its caption. The page around it
// opens a clicked item in its lightbox, with the grid as the group to page through.

import { cn } from '@workspace/ui/lib/utils';
import { Play } from 'lucide-react';
import { Caption } from './media-lightbox';
import type { MediaGridData, MediaItem } from './parse-media-grids';

const GRID_COLUMNS: Record<string, string> = {
    '1': 'grid-cols-1',
    '2': 'grid-cols-1 md:grid-cols-2',
    '3': 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
    '4': 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
    '5': 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5',
    '6': 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6',
};

export function MediaGrid({ columns, items }: MediaGridData) {
    if (items.length === 0) return null;
    return (
        <div className={cn('grid gap-6 my-8', GRID_COLUMNS[columns] ?? GRID_COLUMNS['2'])}>
            {items.map((item, i) => (
                <MediaThumbnail key={i} {...item} />
            ))}
        </div>
    );
}

function MediaThumbnail({ src, type, caption, thumbnail, poster }: MediaItem) {
    const thumbnailSrc = thumbnail ?? src;
    const posterSrc = poster ?? thumbnail;

    return (
        <button type="button" className="group block w-full text-left">
            <div className="relative overflow-hidden rounded-lg bg-muted">
                {type === 'image' && (
                    <img
                        src={thumbnailSrc}
                        alt={caption ?? ''}
                        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                    />
                )}
                {type === 'video' && (
                    <div className="relative w-full h-full">
                        {posterSrc ? (
                            <img src={posterSrc} alt={caption ?? ''} className="w-full h-full object-cover" />
                        ) : (
                            <video src={src} className="w-full h-full object-cover" muted preload="metadata" />
                        )}
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
                            <Play className="size-16 fill-current text-white opacity-80 group-hover:opacity-100 transition-opacity" />
                        </div>
                    </div>
                )}
            </div>
            {caption && (
                <p className="mt-2 text-[11px] text-muted-foreground text-center">
                    <Caption text={caption} />
                </p>
            )}
        </button>
    );
}
