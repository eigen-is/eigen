import { useState } from 'react';
import { MediaPreview } from './MediaPreview';

interface MediaItemProps {
    src: string;
    type: 'image' | 'video';
    caption?: string;
    thumbnail?: string;
    poster?: string;
}

function MediaItem({ src, type, caption, thumbnail, poster }: MediaItemProps) {
    const [isPreviewOpen, setIsPreviewOpen] = useState(false);

    const thumbnailSrc = thumbnail || src;
    const posterSrc = poster || thumbnail;

    return (
        <>
            <div className="group cursor-pointer" onClick={() => setIsPreviewOpen(true)}>
                <div className="relative overflow-hidden rounded-lg bg-muted aspect-video">
                    {type === 'image' && (
                        <img
                            src={thumbnailSrc}
                            alt={caption || ''}
                            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                        />
                    )}
                    {type === 'video' && (
                        <div className="relative w-full h-full">
                            {posterSrc ? (
                                <img src={posterSrc} alt={caption || ''} className="w-full h-full object-cover" />
                            ) : (
                                <video src={src} className="w-full h-full object-cover" muted preload="metadata" />
                            )}
                            <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
                                <svg
                                    className="w-16 h-16 text-white opacity-80 group-hover:opacity-100 transition-opacity"
                                    fill="currentColor"
                                    viewBox="0 0 20 20"
                                >
                                    <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                                </svg>
                            </div>
                        </div>
                    )}
                </div>
                {caption && <p className="mt-2 text-sm text-muted-foreground text-center">{caption}</p>}
            </div>

            {isPreviewOpen && (
                <MediaPreview src={src} type={type} caption={caption} onClose={() => setIsPreviewOpen(false)} />
            )}
        </>
    );
}

interface MediaGridProps {
    columns?: string;
    items?: MediaItemProps[];
}

export function MediaGrid({ columns = '2', items = [] }: MediaGridProps) {
    if (items.length === 0) {
        return null;
    }

    const mediaElements = items.map((item, index) => (
        <MediaItem
            key={index}
            src={item.src}
            type={item.type}
            caption={item.caption}
            thumbnail={item.thumbnail}
            poster={item.poster}
        />
    ));

    const gridColsMap: Record<string, string> = {
        '1': 'grid-cols-1',
        '2': 'grid-cols-1 md:grid-cols-2',
        '3': 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
        '4': 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
        '5': 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5',
        '6': 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6',
    };
    const gridCols = gridColsMap[columns] || 'grid-cols-1 md:grid-cols-2';

    return <div className={`grid ${gridCols} gap-6 my-8`}>{mediaElements}</div>;
}

export function Media(props: MediaItemProps) {
    return <MediaItem {...props} />;
}
