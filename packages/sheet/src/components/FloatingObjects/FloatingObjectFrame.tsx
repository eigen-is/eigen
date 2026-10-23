import { type SheetFloatingItem, sheetFloatingBox } from '@workspace/lib/sheets';
import type { Box } from '@workspace/lib/vector';
import { ObjectTransform } from '@workspace/ui';
import type { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { cn } from '@workspace/ui/lib/utils';
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { deselectFloatingObject, selectFloatingObject, updateFloatingBox } from '../../state';

// Resize floors (scene px === screen px; the grid is unzoomed).
const MIN_SIZE = { image: 20, chart: 40 };

type FloatingObjectFrameProps = {
    item: SheetFloatingItem;
    active: boolean;
    longPress: ReturnType<ReturnType<typeof useLongPress<SheetFloatingItem>>['bind']>;
    onContextMenu: (e: React.MouseEvent) => void;
    onDoubleClick?: () => void;
    children: (box: Box) => ReactNode;
};

// One image or chart on the grid: select, move, resize, rotate, Escape and the menu, the same for both kinds. The
// kind draws only its content. Each gesture previews locally and writes once at its end, only the fields it changed.
export function FloatingObjectFrame({
    item,
    active,
    longPress,
    onContextMenu,
    onDoubleClick,
    children,
}: FloatingObjectFrameProps) {
    const { context, setContext, settings } = useContext(WorkbookContext);
    const { kind, object } = item;
    const ref = { kind, id: object.id };
    const canEdit = context.allowEdit !== false;
    const stored = sheetFloatingBox(object);
    const [preview, setPreview] = useState<Box | null>(null);
    const box = preview ?? stored;

    // The selected object holds the focus, so the workbook's keydown sees Delete.
    const container = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (active) container.current?.focus({ preventScroll: true });
    }, [active]);

    // A peer deleting the object mid-drag unmounts it; the document listeners go with it.
    const drag = useRef<AbortController | null>(null);
    useEffect(() => () => drag.current?.abort(), []);

    const startMove = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        // A finger on an object not yet selected pans the grid; the tap that follows selects it (onClick).
        if (e.pointerType === 'touch' && !active) return;
        if (!active) setContext((ctx) => selectFloatingObject(ctx, ref));
        if (!canEdit) return;
        const controller = new AbortController();
        drag.current?.abort();
        drag.current = controller;
        const start = { x: e.clientX, y: e.clientY };
        const moved = (ev: PointerEvent) => ({
            x: Math.max(0, stored.x + ev.clientX - start.x),
            y: Math.max(0, stored.y + ev.clientY - start.y),
        });
        const { signal } = controller;
        document.addEventListener('pointermove', (ev) => setPreview({ ...stored, ...moved(ev) }), { signal });
        document.addEventListener(
            'pointerup',
            (ev) => {
                controller.abort();
                setPreview(null);
                const { x, y } = moved(ev);
                if (x !== stored.x || y !== stored.y) setContext((ctx) => updateFloatingBox(ctx, ref, { x, y }));
            },
            { signal },
        );
        // A touch the browser took for a pan never ends in pointerup, so the next tap would commit a move.
        document.addEventListener(
            'pointercancel',
            () => {
                controller.abort();
                setPreview(null);
            },
            { signal },
        );
    };

    return (
        // Unrotated and unhit (the pane region is pointer-events none): the content turns inside it, so a hit
        // follows the turned shape, and the ring turns about the same center.
        <div
            ref={container}
            data-floating-id={object.id}
            data-active={active || undefined}
            tabIndex={-1}
            className="absolute outline-none"
            style={{ left: box.x, top: box.y, width: box.width, height: box.height, zIndex: active ? 20 : 19 }}
            onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.stopPropagation();
                setContext(deselectFloatingObject);
            }}
        >
            {/* touch-none only while selected, so a finger on any other object pans the grid. select-none: a
                chart's double-click opens its editor and would otherwise select the drawing's text. */}
            <div
                className={cn(
                    'size-full overflow-hidden pointer-events-auto select-none',
                    kind === 'chart' && 'bg-background',
                    canEdit && 'cursor-move',
                    active && canEdit && 'touch-none',
                )}
                style={{
                    transform: box.angle ? `rotate(${box.angle}deg)` : undefined,
                    transformOrigin: 'center center',
                }}
                {...longPress}
                onPointerDown={(e) => {
                    longPress.onPointerDown(e);
                    startMove(e);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                    e.stopPropagation();
                    if (!active) setContext((ctx) => selectFloatingObject(ctx, ref));
                }}
                onContextMenu={onContextMenu}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    onDoubleClick?.();
                }}
            >
                {children(box)}
            </div>
            {active && canEdit && (
                <ObjectTransform
                    box={box}
                    // The ring fills this already-positioned box; x and y in `box` still drive the resize.
                    boxToStyle={() => ({ left: 0, top: 0, width: box.width, height: box.height })}
                    screenDeltaToScene={(dx, dy) => ({ dx, dy })}
                    showRotate
                    resizeMode={settings.aspectLocked ? 'aspect-default' : 'free'}
                    minSize={MIN_SIZE[kind]}
                    onTransform={setPreview}
                    onGestureEnd={() => setPreview(null)}
                    onCommit={(next, start) => {
                        const fields: Partial<Box> = {};
                        for (const field of ['x', 'y', 'width', 'height', 'angle'] as const) {
                            if (next[field] !== start[field]) fields[field] = next[field];
                        }
                        setContext((ctx) => updateFloatingBox(ctx, ref, fields));
                    }}
                />
            )}
        </div>
    );
}
