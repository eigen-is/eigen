import { getBackgroundStyle } from '@workspace/lib/background';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants/colors';
import { useMediaResolver } from '@workspace/lib/drive';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import type { Box } from '@workspace/lib/vector';
import { useContextMenu } from '@workspace/ui/components/context-menu';
import { ObjectTransform } from '@workspace/ui/components/transform/object-transform';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { boundingBox } from './arrange';
import { useMarqueeSelect } from './hooks/use-marquee-select';
import { useObjectDrag } from './hooks/use-object-drag';
import { snapRect, useSnapTargets } from './hooks/use-snap-lines';
import { SlideObjectView } from './slide-object';
import { getCommentItems, SlideObjectMenu } from './slide-object-menu';
import {
    pxToPercent,
    SLIDE_ASPECT_RATIO,
    SLIDE_BASE_HEIGHT,
    SLIDE_BASE_WIDTH,
    type SlideItem,
    type SlideObject,
} from './types';

// The shared ObjectTransform ring floor (slide units) — a resize can't shrink an object below this.
const SLIDE_MIN_SIZE = 30;

function objToBox(o: SlideObject): Box {
    return { x: o.x, y: o.y, width: o.width, height: o.height, angle: o.angle };
}

type SlideCanvasProps = {
    slide: SlideItem;
    objects: SlideObject[];
    selectedObjectIds: string[];
    editingObjectId: string | null;
    onSelectObject: (objId: string | null, additive?: boolean) => void;
    onSelectObjects: (objIds: string[]) => void;
    onStartEditing: (objId: string) => void;
    onUpdateObject: (objId: string, updates: Partial<SlideObject>) => void;
    onDropImage?: (file: File) => void;
    onCopyObject?: (objId: string) => void;
    onDeleteObject?: (objId: string) => void;
    onMoveUp?: (objId: string) => void;
    onMoveDown?: (objId: string) => void;
    onMoveToFront?: (objId: string) => void;
    onMoveToBack?: (objId: string) => void;
    canWrite: boolean;
    onAddComment?: (objId: string) => void;
    onCommentClick?: (cardId: string) => void;
    cards?: Record<string, CommentCard>;
    entries?: CommentEntry[];
    members?: EffectiveMember[];
    currentUserEmail?: string;
    onCommentAssign?: (chatName: string, email: string | null, title?: string) => void;

    onCommentResolve?: (chatName: string, title?: string) => void;
    onCommentReopen?: (chatName: string, title?: string) => void;
    onCommentChangeColor?: (cardId: string, color: string) => void;
    onCommentDelete?: (objId: string, cardId: string) => void;
    onDuplicateObjects?: (placements: { id: string; x: number; y: number }[]) => void;
    // Lets the editor's layered Escape bail while an ObjectTransform grip drag is live (that gesture
    // owns Escape in the capture phase to cancel itself; the editor must not deselect underneath it).
    onTransformActiveChange?: (active: boolean) => void;
    searchActiveObjectId?: string | null;
    searchMatchedObjectIds?: ReadonlySet<string>;
};

export function SlideCanvas({
    slide,
    objects,
    selectedObjectIds,
    editingObjectId,
    onSelectObject,
    onSelectObjects,
    onStartEditing,
    onUpdateObject,
    onDropImage,
    onCopyObject,
    onDeleteObject,
    onMoveUp,
    onMoveDown,
    onMoveToFront,
    onMoveToBack,
    canWrite,
    onAddComment,
    onCommentClick,
    cards,
    entries,
    members,
    currentUserEmail,
    onCommentAssign,

    onCommentResolve,
    onCommentReopen,
    onCommentChangeColor,
    onCommentDelete,
    onDuplicateObjects,
    onTransformActiveChange,
    searchActiveObjectId,
    searchMatchedObjectIds,
}: SlideCanvasProps) {
    const { resolveMediaUrl } = useMediaResolver();
    const canvasRef = useRef<HTMLDivElement>(null);
    const { vSnaps, hSnaps } = useSnapTargets(objects, selectedObjectIds);
    const objectContextMenu = useContextMenu<SlideObject>();

    // Live local preview of an in-flight resize/rotate (ObjectTransform's onTransform); the single
    // selected object renders from it until the gesture commits. Move previews come from
    // useObjectDrag separately — the two never overlap (a body drag vs. a grip drag).
    const [transformPreview, setTransformPreview] = useState<Box | null>(null);
    const transformStartedRef = useRef(false);

    // Touch long-press opens the same object menu right-click does (mirrors the slide-panel rail).
    const openObjectMenuAt = objectContextMenu.openAt;
    const handleObjectLongPress = useCallback(
        (obj: SlideObject, x: number, y: number) => {
            openObjectMenuAt(obj, x, y);
        },
        [openObjectMenuAt],
    );
    const objectLongPress = useLongPress<SlideObject>(handleObjectLongPress, { disabled: !canWrite });

    const selectedObjects = useMemo(
        () => objects.filter((o) => selectedObjectIds.includes(o.id)),
        [objects, selectedObjectIds],
    );
    const single = selectedObjects.length === 1 ? selectedObjects[0] : null;

    const multiSelectBounds = useMemo(() => {
        if (selectedObjects.length < 2) return null;
        const { minX, minY, maxX, maxY } = boundingBox(selectedObjects);
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }, [selectedObjects]);

    const { startDrag, startGroupDrag, activeSnapLines, dragPreviews } = useObjectDrag({
        onUpdate: onUpdateObject,
        onDuplicate: onDuplicateObjects,
        canvasRef,
        vSnaps,
        hSnaps,
    });

    const { marquee, startMarquee } = useMarqueeSelect({
        objects,
        canvasRef,
        onSelect: onSelectObjects,
    });

    const handleDragStart = useCallback(
        (
            e: React.MouseEvent,
            objId: string,
            mode: 'move',
            x: number,
            y: number,
            width: number,
            height: number,
            angle: number,
        ) => {
            if (mode === 'move' && multiSelectBounds && selectedObjectIds.includes(objId)) {
                startGroupDrag(e, selectedObjects, multiSelectBounds);
            } else {
                startDrag(e, objId, x, y, width, height, angle);
            }
        },
        [startDrag, startGroupDrag, selectedObjectIds, selectedObjects, multiSelectBounds],
    );

    const handleCanvasMouseDown = useCallback(
        (e: React.MouseEvent) => {
            if (e.target === canvasRef.current) {
                onSelectObject(null);
                if (canWrite) {
                    startMarquee(e);
                }
            }
        },
        [onSelectObject, canWrite, startMarquee],
    );

    const handleBoundsMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            if (canWrite && multiSelectBounds) {
                startGroupDrag(e, selectedObjects, multiSelectBounds);
            }
        },
        [canWrite, startGroupDrag, selectedObjects, multiSelectBounds],
    );

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
            if (files.length === 0 || !onDropImage) return;
            for (const file of files) {
                onDropImage(file);
            }
        },
        [onDropImage],
    );

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    }, []);

    const handleOuterMouseDown = useCallback(
        (e: React.MouseEvent) => {
            if (e.target === e.currentTarget) {
                onSelectObject(null);
            }
        },
        [onSelectObject],
    );

    // Move previews (x/y only) keyed by id. Resize/rotate use transformPreview instead.
    const movePreviewMap = useMemo(() => {
        const map = new Map<string, { x: number; y: number }>();
        for (const p of dragPreviews) map.set(p.objId, { x: p.x, y: p.y });
        return map;
    }, [dragPreviews]);

    // An object renders with its live local preview (move or single-selection transform) overriding
    // the stored geometry; no preview → same object, unchanged.
    const displayObject = useCallback(
        (obj: SlideObject): SlideObject => {
            const move = movePreviewMap.get(obj.id);
            if (move) return { ...obj, x: move.x, y: move.y };
            if (transformPreview && single?.id === obj.id) {
                return {
                    ...obj,
                    x: transformPreview.x,
                    y: transformPreview.y,
                    width: transformPreview.width,
                    height: transformPreview.height,
                    angle: transformPreview.angle,
                };
            }
            return obj;
        },
        [movePreviewMap, transformPreview, single],
    );

    // ObjectTransform coordinate seam. The ring is positioned in percent CSS (tracks container
    // resize for free); pointer deltas convert to slide units by the live canvas size.
    const boxToStyle = useCallback(
        (box: Box): React.CSSProperties => ({
            left: `${pxToPercent(box.x, 'x')}%`,
            top: `${pxToPercent(box.y, 'y')}%`,
            width: `${pxToPercent(box.width, 'x')}%`,
            height: `${pxToPercent(box.height, 'y')}%`,
        }),
        [],
    );
    const screenDeltaToScene = useCallback((dxPx: number, dyPx: number) => {
        const el = canvasRef.current;
        const w = el?.clientWidth || 1;
        const h = el?.clientHeight || 1;
        return { dx: (dxPx / w) * SLIDE_BASE_WIDTH, dy: (dyPx / h) * SLIDE_BASE_HEIGHT };
    }, []);

    // Resize-time snapping (the resize half of the old snap system). Pure: ObjectTransform applies
    // it before the latch and re-clamps minSize after, and only on a plain resize (aspect/from-center
    // skip it). A rotated box's axis-aligned rect doesn't match its visual box, so it isn't snapped
    // (same skip as move). The moved edges are inferred by diffing against the selected object's start
    // box — stable during a local gesture — so no drag mode is threaded through.
    const snapBox = useCallback(
        (b: Box): Box => {
            if (b.angle !== 0 || !single) return b;
            const EPS = 0.001;
            const movedLeft = Math.abs(b.x - single.x) > EPS;
            const movedRight = Math.abs(b.x + b.width - (single.x + single.width)) > EPS;
            const movedTop = Math.abs(b.y - single.y) > EPS;
            const movedBottom = Math.abs(b.y + b.height - (single.y + single.height)) > EPS;
            let mode = 'resize-';
            if (movedTop) mode += 'n';
            else if (movedBottom) mode += 's';
            if (movedLeft) mode += 'w';
            else if (movedRight) mode += 'e';
            if (mode === 'resize-') return b; // nothing moved yet
            const snapped = snapRect({ x: b.x, y: b.y, w: b.width, h: b.height }, vSnaps, hSnaps, mode);
            return { x: snapped.x, y: snapped.y, width: snapped.w, height: snapped.h, angle: 0 };
        },
        [single, vSnaps, hSnaps],
    );

    // Any pointerup ends a transform: reset the start latch, tell the editor the drag is over, and
    // drop a leftover preview — an Escape-cancel or no-move click fires no onCommit, so its snapshot
    // preview would otherwise stick and mask later remote edits. Registered at mount, so on a normal
    // commit this runs before ObjectTransform's own pointerup listener; the onCommit write supersedes
    // the clear in the same render.
    useEffect(() => {
        const clear = () => {
            transformStartedRef.current = false;
            onTransformActiveChange?.(false);
            setTransformPreview((p) => (p ? null : p));
        };
        document.addEventListener('pointerup', clear);
        document.addEventListener('pointercancel', clear);
        // A window blur mid-grip delivers no pointerup (ObjectTransform's blur commit fires no
        // onCommit on a no-move gesture), and an unmount mid-gesture skips both — clear on each so
        // the editor's Escape latch can't stick.
        window.addEventListener('blur', clear);
        return () => {
            document.removeEventListener('pointerup', clear);
            document.removeEventListener('pointercancel', clear);
            window.removeEventListener('blur', clear);
            clear();
        };
    }, [onTransformActiveChange]);

    const showTransform = canWrite && single !== null && single.id !== editingObjectId;
    const transformBox = single ? objToBox(displayObject(single)) : null;

    return (
        <div
            className="flex-1 flex items-center justify-center p-6 bg-muted overflow-hidden"
            onMouseDown={handleOuterMouseDown}
        >
            {/* eigen-paper: the slide surface always renders light, in dark mode too (globals.css) */}
            <div
                ref={canvasRef}
                className="eigen-paper relative w-full shadow-lg rounded-lg overflow-hidden"
                style={{
                    aspectRatio: SLIDE_ASPECT_RATIO,
                    maxHeight: '100%',
                    maxWidth: '100%',
                    containerType: 'size',
                    // Explicit stacking context for the canvas-internal overlay tiers below.
                    isolation: 'isolate',
                    ...getBackgroundStyle(slide.background, resolveMediaUrl),
                }}
                onMouseDown={handleCanvasMouseDown}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
            >
                {objects.map((obj) => {
                    const displayObj = displayObject(obj);
                    const commentItems = getCommentItems(obj, cards, entries);
                    const firstUnresolved = commentItems.find(({ entry }) => entry?.status !== 'resolved');
                    return (
                        <SlideObjectView
                            key={obj.id}
                            obj={displayObj}
                            selected={selectedObjectIds.includes(obj.id)}
                            editing={editingObjectId === obj.id}
                            editable={canWrite}
                            isMultiSelected={selectedObjectIds.length > 1 && selectedObjectIds.includes(obj.id)}
                            searchActive={searchActiveObjectId === obj.id}
                            searchMatched={searchMatchedObjectIds?.has(obj.id)}
                            onSelect={onSelectObject}
                            onStartEditing={onStartEditing}
                            onUpdate={onUpdateObject}
                            onDragStart={handleDragStart}
                            onContextMenu={canWrite ? objectContextMenu.handleContextMenu : undefined}
                            longPressBind={canWrite ? objectLongPress.bind : undefined}
                            onCommentClick={onCommentClick}
                            commentColor={
                                firstUnresolved?.card.color ??
                                (firstUnresolved ? EIGEN_STICKIES_COLORS[0][1].value : undefined)
                            }
                            firstCommentCardId={firstUnresolved?.card.id}
                        />
                    );
                })}
                {showTransform && single && transformBox && (
                    <ObjectTransform
                        box={transformBox}
                        boxToStyle={boxToStyle}
                        screenDeltaToScene={screenDeltaToScene}
                        showRotate
                        minSize={SLIDE_MIN_SIZE}
                        snapBox={snapBox}
                        onTransform={(next) => {
                            if (!transformStartedRef.current) {
                                transformStartedRef.current = true;
                                onTransformActiveChange?.(true);
                            }
                            setTransformPreview(next);
                        }}
                        onCommit={(next, start) => {
                            transformStartedRef.current = false;
                            onTransformActiveChange?.(false);
                            // Write only the fields the gesture changed — a rotate must not clobber a
                            // peer's concurrent move/resize with its stale snapshot values.
                            const fields: Partial<SlideObject> = {};
                            if (next.x !== start.x) fields.x = next.x;
                            if (next.y !== start.y) fields.y = next.y;
                            if (next.width !== start.width) fields.width = next.width;
                            if (next.height !== start.height) fields.height = next.height;
                            if (next.angle !== start.angle) fields.angle = next.angle;
                            if (Object.keys(fields).length) onUpdateObject(single.id, fields);
                            setTransformPreview(null);
                        }}
                    />
                )}
                {activeSnapLines.map((line, i) => (
                    <div
                        key={i}
                        className="absolute pointer-events-none z-30 bg-selection-handle"
                        style={
                            line.orientation === 'vertical'
                                ? { left: `${pxToPercent(line.position, 'x')}%`, top: 0, bottom: 0, width: '1px' }
                                : { top: `${pxToPercent(line.position, 'y')}%`, left: 0, right: 0, height: '1px' }
                        }
                    />
                ))}
                {multiSelectBounds && !dragPreviews.length && (
                    <div
                        className="absolute z-20 border border-dashed border-selection-handle cursor-move"
                        style={{
                            left: `${pxToPercent(multiSelectBounds.x, 'x')}%`,
                            top: `${pxToPercent(multiSelectBounds.y, 'y')}%`,
                            width: `${pxToPercent(multiSelectBounds.w, 'x')}%`,
                            height: `${pxToPercent(multiSelectBounds.h, 'y')}%`,
                        }}
                        onMouseDown={handleBoundsMouseDown}
                    />
                )}
                {marquee && (
                    <div
                        className={cn(
                            'absolute pointer-events-none z-30 border border-selection-handle bg-selection-handle/10',
                            marquee.mode === 'intersect' && 'border-dashed',
                        )}
                        style={{
                            left: `${pxToPercent(marquee.x, 'x')}%`,
                            top: `${pxToPercent(marquee.y, 'y')}%`,
                            width: `${pxToPercent(marquee.w, 'x')}%`,
                            height: `${pxToPercent(marquee.h, 'y')}%`,
                        }}
                    />
                )}
            </div>
            <SlideObjectMenu
                contextMenu={objectContextMenu}
                cards={cards}
                entries={entries}
                onCopy={onCopyObject}
                onDelete={onDeleteObject}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
                onMoveToFront={onMoveToFront}
                onMoveToBack={onMoveToBack}
                onAddComment={onAddComment}
                onCommentClick={onCommentClick}
                onCommentChangeColor={onCommentChangeColor}
                members={members}
                currentUserEmail={currentUserEmail}
                onCommentAssign={onCommentAssign}
                onCommentResolve={onCommentResolve}
                onCommentReopen={onCommentReopen}
                onCommentDelete={onCommentDelete}
            />
        </div>
    );
}
