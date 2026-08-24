import type { Box } from '@workspace/lib/vector';
import { ImagePlaceholder } from '@workspace/ui/components/media/image-placeholder';
import { ObjectTransform } from '@workspace/ui/components/transform/object-transform';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { WorkbookContext } from '../../context';
import { onImageMoveStart, updateImage } from '../../state';
import type { Image } from '../../state/types';

// Floating-image resize floor (scene px === screen px; the grid is unzoomed).
const MIN_IMAGE_SIZE = 20;

function useResolvedImageUrl(mediaName: string | undefined) {
    const { settings } = useContext(WorkbookContext);
    return useMemo(
        () => (mediaName ? (settings.hooks?.resolveImageUrl?.(mediaName) ?? null) : null),
        [mediaName, settings.hooks],
    );
}

function ActiveImage({ img }: { img: Image }) {
    const { context, setContext, settings, refs } = useContext(WorkbookContext);
    const url = useResolvedImageUrl(img.mediaName);
    const showPlaceholder = !url && img.mediaName.startsWith('pending:');

    // Live resize/rotate preview — never committed until onCommit. Move stays imperative (image.ts),
    // so it never touches this: the ObjectTransform ring is a child of the moved container below and
    // rides along in the DOM for free.
    const [preview, setPreview] = useState<Box | null>(null);
    const box: Box = preview ?? {
        x: img.x,
        y: img.y,
        width: img.width,
        height: img.height,
        angle: img.angle ?? 0,
    };

    // Safety net (vector's idiom): ObjectTransform's Escape-cancel and no-move paths fire no onCommit,
    // so their snapshot preview would otherwise stick and mask later panel/remote edits. Any pointerup
    // or window blur drops a leftover preview; a real commit's setContext write supersedes it.
    useEffect(() => {
        const clear = () => setPreview((p) => (p ? null : p));
        document.addEventListener('pointerup', clear);
        window.addEventListener('blur', clear);
        return () => {
            document.removeEventListener('pointerup', clear);
            window.removeEventListener('blur', clear);
        };
    }, []);

    return (
        // Positioned, UNROTATED container: the imperative move mutates its left/top directly, and the
        // ObjectTransform ring (a child) moves with it. Rotation lives on the content + ring, both
        // around this box's centre, so they overlap exactly. Sits inside the 'main' pane region, so it
        // inherits the same scroll offset + freeze clipping as every image.
        <div
            id="luckysheet-modal-dialog-activeImage"
            // pointer-events-auto: the pane-region wrapper is pointer-events none
            className="absolute pointer-events-auto"
            style={{
                zIndex: 20,
                width: box.width,
                height: box.height,
                left: box.x,
                top: box.y,
            }}
        >
            {/* Class kept for DOM querySelector idioms; move drag lives here. */}
            <div
                className="luckysheet-modal-dialog-content cursor-move"
                style={{
                    width: box.width,
                    height: box.height,
                    transform: box.angle ? `rotate(${box.angle}deg)` : undefined,
                    transformOrigin: 'center center',
                    backgroundImage: url ? `url(${url})` : undefined,
                    backgroundSize: `${box.width}px ${box.height}px`,
                    backgroundRepeat: 'no-repeat',
                }}
                onMouseDown={(e) => {
                    onImageMoveStart(context, refs.globalCache, e.nativeEvent);
                    e.stopPropagation();
                }}
            >
                {showPlaceholder && <ImagePlaceholder />}
            </div>
            {context.allowEdit === false ? null : (
                <ObjectTransform
                    box={box}
                    // The ring fills this already-positioned container; ObjectTransform adds its own
                    // centre-origin rotate, so the ring tracks the rotated content. x/y in `box` still
                    // drive the resize math + commit; only the visual position is inherited from here.
                    boxToStyle={() => ({ left: 0, top: 0, width: box.width, height: box.height })}
                    // Grid is unzoomed: a screen px is a scene px.
                    screenDeltaToScene={(dx, dy) => ({ dx, dy })}
                    showRotate
                    resizeMode={settings.imageAspectLocked ? 'aspect-default' : 'free'}
                    minSize={MIN_IMAGE_SIZE}
                    onTransform={setPreview}
                    onCommit={(next, start) => {
                        setPreview(null);
                        const fields: Partial<Pick<Image, 'x' | 'y' | 'width' | 'height' | 'angle'>> = {};
                        if (next.x !== start.x) fields.x = next.x;
                        if (next.y !== start.y) fields.y = next.y;
                        if (next.width !== start.width) fields.width = next.width;
                        if (next.height !== start.height) fields.height = next.height;
                        if (next.angle !== start.angle) fields.angle = next.angle;
                        if (Object.keys(fields).length > 0) {
                            setContext((ctx) => updateImage(ctx, img.id, fields));
                        }
                    }}
                />
            )}
        </div>
    );
}

function InactiveImage({ img }: { img: Image }) {
    const { setContext } = useContext(WorkbookContext);
    const url = useResolvedImageUrl(img.mediaName);
    const w = img.width;
    const h = img.height;
    const rotate = img.angle ? `rotate(${img.angle}deg)` : undefined;

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
                        transform: rotate,
                        transformOrigin: 'center center',
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
                transform: rotate,
                transformOrigin: 'center center',
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
            {/* key: reset the resize/rotate preview when the active image changes. */}
            {activeImg && <ActiveImage key={activeImg.id} img={activeImg} />}
            {context.insertedImgs?.map((img) => {
                if (img.id === context.activeImg) return null;
                return <InactiveImage key={img.id} img={img} />;
            })}
        </div>
    );
}
