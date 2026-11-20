// A grid of images and videos inside a blog post or Support article, which the article's Markdown declares as a
// `::: grid` block. Each item is a button with a thumbnail, a play mark on a video, the full-screen mark the site's
// other pictures show, and its caption. The caption names the button, so the thumbnail has empty alt text. A click
// hands the page around it the item to open in its lightbox, with the grid as the group.

import { cn } from '@workspace/ui/lib/utils';
import { Maximize, Play } from 'lucide-react';
import type { MediaGridData, MediaItem } from '../../scripts/lib/content-types';
import type { OpenLightbox } from './media-lightbox';
import { Caption } from './media-lightbox';

const GRID_COLUMNS: Readonly<Record<MediaGridData['columns'], string>> = {
    '1': 'grid-cols-1',
    '2': 'grid-cols-1 md:grid-cols-2',
    '3': 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
    '4': 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
    '5': 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5',
    '6': 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6',
};

export function MediaGrid({ columns, items, onOpen }: MediaGridData & { onOpen: OpenLightbox }) {
    return (
        <div className={cn('media-grid grid gap-6 my-8', GRID_COLUMNS[columns])}>
            {items.map((item, i) => (
                <MediaThumbnail key={i} {...item} onClick={() => onOpen(items, i)} />
            ))}
        </div>
    );
}

function MediaThumbnail({ src, type, caption, thumbnail, poster, onClick }: MediaItem & { onClick: () => void }) {
    return (
        <button type="button" className="group block w-full cursor-pointer text-left" onClick={onClick}>
            <div className="media-frame overflow-hidden rounded-lg bg-muted">
                {type === 'image' && (
                    <img
                        src={thumbnail ?? src}
                        alt=""
                        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                    />
                )}
                {type === 'video' && (
                    <div className="relative w-full h-full">
                        {poster ? (
                            <img src={poster} alt="" className="w-full h-full object-cover" />
                        ) : (
                            <video
                                src={src}
                                className="w-full h-full object-cover"
                                muted
                                preload="metadata"
                                aria-hidden="true"
                            />
                        )}
                        {/* Black and white, not theme tokens, on purpose: the mark sits on any photo, in either theme. */}
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
                            <Play className="size-16 fill-current text-white opacity-80 group-hover:opacity-100 transition-opacity" />
                        </div>
                    </div>
                )}
                {/* The whole thumbnail is the button, so the mark only shows what a click does. */}
                <span className="media-expand" aria-hidden="true">
                    <Maximize />
                </span>
            </div>
            <p className="mt-2 text-2xs text-muted-foreground text-center">
                <Caption text={caption} />
            </p>
        </button>
    );
}
