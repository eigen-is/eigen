import { useMediaResolver } from '@workspace/lib/drive';
import { cn } from '@workspace/ui/lib/utils';
import { memo } from 'react';
import { ReadOnlySlideObject } from './slide-object';
import { SLIDE_ASPECT_RATIO, type SlideItem, type SlideObject } from './types';

type SlideThumbnailProps = {
    slide: SlideItem;
    objects: SlideObject[];
    index: number;
    isActive: boolean;
    onClick: () => void;
};

export const SlideThumbnail = memo(function SlideThumbnail({
    slide,
    objects,
    index,
    isActive,
    onClick,
}: SlideThumbnailProps) {
    const { resolveMediaUrl } = useMediaResolver();
    const bgUrl = slide.backgroundMediaName ? resolveMediaUrl(slide.backgroundMediaName) : null;

    return (
        <button
            onClick={onClick}
            className={cn(
                'w-full flex items-start gap-2 py-1 px-1 rounded-sm text-left group',
                isActive && 'bg-accent',
            )}
        >
            <span className="text-[10px] text-muted-foreground w-4 text-right flex-shrink-0 mt-1">{index + 1}</span>
            <div
                className={cn(
                    'flex-1 min-w-0 rounded border overflow-hidden',
                    isActive ? 'border-blue-500 shadow-sm' : 'border-border',
                )}
                style={{ aspectRatio: SLIDE_ASPECT_RATIO }}
            >
                <div
                    className="w-full h-full relative"
                    style={{
                        containerType: 'size',
                        backgroundColor: slide.backgroundColor,
                        ...(bgUrl
                            ? {
                                  backgroundImage: `url(${bgUrl})`,
                                  backgroundSize: 'cover',
                                  backgroundPosition: 'center',
                              }
                            : {}),
                    }}
                >
                    {objects.map((obj) => (
                        <ReadOnlySlideObject key={obj.id} obj={obj} />
                    ))}
                </div>
            </div>
        </button>
    );
});
