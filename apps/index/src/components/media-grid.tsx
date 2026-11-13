// A grid of images and videos inside a blog post or Support article, which the article's markdown declares as a
// media block. Each item shows a thumbnail, a play mark on a video, and its caption; clicking it opens the full image
// or plays the video in a dialog.

import { Dialog, DialogContent, DialogTitle } from '@workspace/ui/components/dialog';
import { cn } from '@workspace/ui/lib/utils';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { splitKetNames } from './ket-names';

type MediaItemProps = {
    src: string;
    type: 'image' | 'video';
    caption?: string;
    thumbnail?: string;
    poster?: string;
};

// A caption as text, with each app name in the class the site's prose gives app names.
function Caption({ text }: { text: string }) {
    return splitKetNames(text).map((part, i) =>
        i % 2 ? (
            <span key={i} className="ket-name">
                {part}
            </span>
        ) : (
            part
        ),
    );
}

function MediaItem({ src, type, caption, thumbnail, poster }: MediaItemProps) {
    const [isPreviewOpen, setIsPreviewOpen] = useState(false);

    const thumbnailSrc = thumbnail ?? src;
    const posterSrc = poster ?? thumbnail;

    return (
        <>
            <button type="button" className="group block w-full text-left" onClick={() => setIsPreviewOpen(true)}>
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
                    <p className="mt-2 text-sm text-muted-foreground text-center">
                        <Caption text={caption} />
                    </p>
                )}
            </button>

            <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
                <DialogContent className="w-auto sm:max-w-[90vw] justify-items-center">
                    <DialogTitle className="sr-only">{caption ?? 'Media preview'}</DialogTitle>
                    {type === 'image' && (
                        <img src={src} alt={caption ?? 'Preview'} className="max-w-full max-h-[80vh] rounded" />
                    )}
                    {type === 'video' && (
                        <video src={src} controls autoPlay className="max-w-full max-h-[80vh] rounded" />
                    )}
                    {caption && (
                        <p className="text-sm text-muted-foreground text-center max-w-2xl">
                            <Caption text={caption} />
                        </p>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}

type MediaGridProps = {
    columns?: string;
    items?: MediaItemProps[];
};

export function MediaGrid({ columns = '2', items = [] }: MediaGridProps) {
    if (items.length === 0) {
        return null;
    }

    const mediaElements = items.map((item, index) => <MediaItem key={index} {...item} />);

    const gridColsMap: Record<string, string> = {
        '1': 'grid-cols-1',
        '2': 'grid-cols-1 md:grid-cols-2',
        '3': 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
        '4': 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
        '5': 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5',
        '6': 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6',
    };
    const gridCols = gridColsMap[columns] ?? 'grid-cols-1 md:grid-cols-2';

    return <div className={cn('grid', gridCols, 'gap-6 my-8')}>{mediaElements}</div>;
}
