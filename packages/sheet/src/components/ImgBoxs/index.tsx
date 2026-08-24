import { ImagePlaceholder } from '@workspace/ui/components/media/image-placeholder';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useContext, useMemo } from 'react';
import { WorkbookContext } from '../../context';
import { onImageMoveStart, onImageResizeStart } from '../../state';
import type { Image } from '../../state/types';

const HANDLE_POSITIONS = [
    { key: 'lt', className: '-top-1.5 -left-1.5 cursor-nwse-resize' },
    { key: 'mt', className: '-top-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize' },
    { key: 'rt', className: '-top-1.5 -right-1.5 cursor-nesw-resize' },
    { key: 'lm', className: 'top-1/2 -left-1.5 -translate-y-1/2 cursor-ew-resize' },
    { key: 'rm', className: 'top-1/2 -right-1.5 -translate-y-1/2 cursor-ew-resize' },
    { key: 'lb', className: '-bottom-1.5 -left-1.5 cursor-nesw-resize' },
    { key: 'mb', className: '-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize' },
    { key: 'rb', className: '-bottom-1.5 -right-1.5 cursor-nwse-resize' },
] as const;

function useResolvedImageUrl(mediaName: string | undefined) {
    const { settings } = useContext(WorkbookContext);
    return useMemo(
        () => (mediaName ? (settings.hooks?.resolveImageUrl?.(mediaName) ?? null) : null),
        [mediaName, settings.hooks],
    );
}

function ActiveImage({ img }: { img: Image }) {
    const { context, refs } = useContext(WorkbookContext);
    const url = useResolvedImageUrl(img.mediaName);
    const w = img.width;
    const h = img.height;
    const showPlaceholder = !url && img.mediaName.startsWith('pending:');

    return (
        <div
            id="luckysheet-modal-dialog-activeImage"
            // pointer-events-auto: the pane-region wrapper is pointer-events none
            className="absolute pointer-events-auto eigen-selection-ring"
            style={{
                zIndex: 20,
                width: w,
                height: h,
                left: img.x,
                top: img.y,
            }}
        >
            {/* Class kept for DOM querySelector in image.ts resize logic */}
            <div
                className="luckysheet-modal-dialog-content cursor-move"
                style={{
                    width: w,
                    height: h,
                    backgroundImage: url ? `url(${url})` : undefined,
                    backgroundSize: `${w}px ${h}px`,
                    backgroundRepeat: 'no-repeat',
                }}
                onMouseDown={(e) => {
                    onImageMoveStart(context, refs.globalCache, e.nativeEvent);
                    e.stopPropagation();
                }}
            >
                {showPlaceholder && <ImagePlaceholder />}
            </div>
            {HANDLE_POSITIONS.map(({ key, className }) => (
                <div
                    key={key}
                    className={cn('eigen-selection-handle', className)}
                    data-type={key}
                    onMouseDown={(e) => {
                        onImageResizeStart(refs.globalCache, e.nativeEvent, key);
                        e.stopPropagation();
                    }}
                />
            ))}
        </div>
    );
}

function InactiveImage({ img }: { img: Image }) {
    const { setContext } = useContext(WorkbookContext);
    const url = useResolvedImageUrl(img.mediaName);
    const w = img.width;
    const h = img.height;

    const handleClick = useCallback(
        (e: React.MouseEvent) => {
            setContext((ctx) => {
                ctx.activeImg = img.id;
            });
            e.stopPropagation();
        },
        [setContext, img.id],
    );

    if (!url) {
        if (img.mediaName.startsWith('pending:')) {
            return (
                <div
                    id={img.id}
                    className="absolute overflow-hidden pointer-events-auto"
                    style={{
                        width: w,
                        height: h,
                        left: img.x,
                        top: img.y,
                        zIndex: 19,
                    }}
                >
                    <ImagePlaceholder />
                </div>
            );
        }
        return null;
    }

    return (
        <div
            id={img.id}
            // pointer-events-auto: the pane-region wrapper is pointer-events none
            className="absolute overflow-hidden pointer-events-auto"
            style={{
                width: w,
                height: h,
                left: img.x,
                top: img.y,
                zIndex: 19,
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleClick}
            tabIndex={0}
        >
            <img src={url} alt="" style={{ width: w, height: h }} decoding="async" />
        </div>
    );
}

export function ImgBoxs() {
    const { context } = useContext(WorkbookContext);
    const activeImg = useMemo(() => {
        return context.insertedImgs?.find((img) => img.id === context.activeImg);
    }, [context.activeImg, context.insertedImgs]);

    return (
        <div id="luckysheet-image-showBoxs">
            {activeImg && <ActiveImage img={activeImg} />}
            {context.insertedImgs?.map((img) => {
                if (img.id === context.activeImg) return null;
                return <InactiveImage key={img.id} img={img} />;
            })}
        </div>
    );
}
