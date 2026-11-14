// A picture or film from a page of the public site shown bigger in a dialog, its caption under it, such as an item
// of a media grid or an image or looping video in an article. Opened from a group, such as the grid or a carousel,
// it pages through the group with its arrows and the arrow keys. A film plays with controls unless the reader asked
// for less motion, and a looping one stays a muted loop.

import { useMediaQuery } from '@workspace/lib/media';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogTitle } from '@workspace/ui/components/dialog';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { splitKetNames } from './ket-names';
import type { MediaItem } from './parse-media-grids';

export type LightboxItem = MediaItem & { loop?: boolean };

type MediaLightboxProps = {
    items: readonly LightboxItem[];
    index: number;
    open: boolean;
    onIndexChange: (index: number) => void;
    onOpenChange: (open: boolean) => void;
};

export function MediaLightbox({ items, index, open, onIndexChange, onOpenChange }: MediaLightboxProps) {
    const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
    const item = items[index];
    const step = (by: number) => {
        if (items[index + by]) onIndexChange(index + by);
    };
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'ArrowLeft') step(-1);
        if (e.key === 'ArrowRight') step(1);
    };

    return (
        <Dialog open={open && item !== undefined} onOpenChange={onOpenChange}>
            <DialogContent className="justify-items-center p-4 sm:max-w-6xl sm:p-6" onKeyDown={onKeyDown}>
                <DialogTitle className="sr-only">{item?.caption ?? 'Media preview'}</DialogTitle>
                {item?.type === 'image' && (
                    <img src={item.src} alt={item.caption ?? ''} className="max-h-[75vh] max-w-full rounded" />
                )}
                {item?.type === 'video' && (
                    <video
                        key={item.src}
                        src={item.src}
                        poster={item.poster}
                        controls
                        playsInline
                        autoPlay={!reduceMotion}
                        muted={item.loop}
                        loop={item.loop}
                        className="max-h-[75vh] max-w-full rounded"
                    />
                )}
                {(item?.caption || items.length > 1) && (
                    <div className="flex w-full max-w-2xl items-center gap-3">
                        {items.length > 1 && (
                            <Button
                                variant="outline"
                                size="icon"
                                className="rounded-full"
                                aria-label="Previous"
                                disabled={index === 0}
                                onClick={() => step(-1)}
                            >
                                <ChevronLeft />
                            </Button>
                        )}
                        <p className="flex-1 text-center text-sm text-muted-foreground">
                            {item?.caption && <Caption text={item.caption} />}
                        </p>
                        {items.length > 1 && (
                            <Button
                                variant="outline"
                                size="icon"
                                className="rounded-full"
                                aria-label="Next"
                                disabled={index === items.length - 1}
                                onClick={() => step(1)}
                            >
                                <ChevronRight />
                            </Button>
                        )}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

// A caption as text, with each app name in the class the site's prose gives app names.
export function Caption({ text }: { text: string }) {
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
