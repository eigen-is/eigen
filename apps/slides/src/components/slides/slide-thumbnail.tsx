import {memo} from 'react';
import {SlideItem, SlideObject, SLIDE_ASPECT_RATIO, pxToPercent} from './types';
import {cn} from '@workspace/ui/lib/utils';

type SlideThumbnailProps = {
    slide: SlideItem;
    objects: SlideObject[];
    index: number;
    isActive: boolean;
    onClick: () => void;
}

export const SlideThumbnail = memo(function SlideThumbnail({slide, objects, index, isActive, onClick}: SlideThumbnailProps) {
    return (
        <button
            onClick={onClick}
            className={cn(
                'w-full flex items-start gap-2 py-1 px-1 rounded-sm text-left group',
                isActive && 'bg-accent',
            )}
        >
            <span className="text-[10px] text-muted-foreground w-4 text-right flex-shrink-0 mt-1">
                {index + 1}
            </span>
            <div
                className={cn(
                    'flex-1 min-w-0 rounded border overflow-hidden',
                    isActive ? 'border-blue-500 shadow-sm' : 'border-border',
                )}
                style={{aspectRatio: SLIDE_ASPECT_RATIO}}
            >
                <div className="w-full h-full relative" style={{
                    backgroundColor: slide.backgroundColor,
                    ...(slide.backgroundImage ? {backgroundImage: `url(${slide.backgroundImage})`, backgroundSize: 'cover', backgroundPosition: 'center'} : {}),
                }}>
                    {objects.map((obj) => (
                        <ThumbnailObject key={obj.id} obj={obj} bgColor={slide.backgroundColor}/>
                    ))}
                </div>
            </div>
        </button>
    );
});

const ThumbnailObject = memo(function ThumbnailObject({obj, bgColor}: {obj: SlideObject; bgColor: string}) {
    const isDark = isDarkColor(bgColor);

    return (
        <div
            className="absolute overflow-hidden"
            style={{
                left: `${pxToPercent(obj.x, 'x')}%`,
                top: `${pxToPercent(obj.y, 'y')}%`,
                width: `${pxToPercent(obj.w, 'x')}%`,
                height: `${pxToPercent(obj.h, 'y')}%`,
                transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
            }}
        >
            {obj.type === 'text' && (
                <div
                    className="w-full h-full flex items-center"
                    style={{
                        justifyContent: obj.textAlign === 'center' ? 'center' : obj.textAlign === 'right' ? 'flex-end' : 'flex-start',
                    }}
                >
                    <p
                        className="truncate w-full"
                        style={{
                            fontSize: '4px',
                            fontWeight: obj.fontWeight,
                            textAlign: obj.textAlign,
                            color: obj.color || (isDark ? '#ffffff' : '#000000'),
                            lineHeight: 1.1,
                        }}
                    >
                        {obj.text}
                    </p>
                </div>
            )}
            {obj.type === 'image' && (
                <img
                    src={obj.src}
                    className="w-full h-full"
                    style={{objectFit: obj.objectFit}}
                    draggable={false}
                    alt=""
                />
            )}
        </div>
    );
});

function isDarkColor(hex: string): boolean {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}
