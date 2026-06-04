import { getBackgroundStyle } from '@workspace/lib/background';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants/colors';
import { useMediaResolver } from '@workspace/lib/drive';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useMemo, useRef } from 'react';
import { boundingBox } from './arrange';
import { useMarqueeSelect } from './hooks/use-marquee-select';
import { type DragMode, useObjectDrag } from './hooks/use-object-drag';
import { useSnapTargets } from './hooks/use-snap-lines';
import { SlideObjectView } from './slide-object';
import { SelectionChrome } from './slide-selection-chrome';
import { normalizeAngle } from './transform-geometry';
import { pxToPercent, SLIDE_ASPECT_RATIO, type SlideItem, type SlideObject } from './types';

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

    onCommentResolve?: (chatName: string) => void;
    onCommentReopen?: (chatName: string) => void;
    onCommentChangeColor?: (cardId: string, color: string) => void;
    onCommentDelete?: (objId: string, cardId: string) => void;
    onDuplicateObjects?: (placements: { id: string; x: number; y: number }[]) => void;
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

    onCommentResolve,
    onCommentReopen,
    onCommentChangeColor,
    onCommentDelete,
    onDuplicateObjects,
}: SlideCanvasProps) {
    const { resolveMediaUrl } = useMediaResolver();
    const canvasRef = useRef<HTMLDivElement>(null);
    const { vSnaps, hSnaps } = useSnapTargets(objects, selectedObjectIds);

    const selectedObjects = useMemo(
        () => objects.filter((o) => selectedObjectIds.includes(o.id)),
        [objects, selectedObjectIds],
    );

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
            w: number,
            h: number,
            rotation: number,
        ) => {
            if (mode === 'move' && multiSelectBounds && selectedObjectIds.includes(objId)) {
                startGroupDrag(e, selectedObjects, multiSelectBounds);
            } else {
                startDrag(e, objId, mode, x, y, w, h, rotation);
            }
        },
        [startDrag, startGroupDrag, selectedObjectIds, selectedObjects, multiSelectBounds],
    );

    const handleResizeStart = useCallback(
        (
            e: React.MouseEvent,
            objId: string,
            mode: string,
            x: number,
            y: number,
            w: number,
            h: number,
            rotation: number,
        ) => {
            startDrag(e, objId, mode as DragMode, x, y, w, h, rotation);
        },
        [startDrag],
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

    const dragPreviewMap = useMemo(() => {
        const map = new Map<string, { x: number; y: number; w: number; h: number; rotation?: number }>();
        for (const p of dragPreviews) {
            map.set(p.objId, p);
        }
        return map;
    }, [dragPreviews]);

    const handleRotateStart = useCallback(
        (e: React.MouseEvent, objId: string, x: number, y: number, w: number, h: number, rotation: number) => {
            startDrag(e, objId, 'rotate', x, y, w, h, rotation);
        },
        [startDrag],
    );

    return (
        <div
            className="flex-1 flex items-center justify-center p-6 bg-muted overflow-hidden"
            onMouseDown={handleOuterMouseDown}
        >
            <div
                ref={canvasRef}
                className="relative w-full shadow-lg rounded-lg overflow-hidden"
                style={{
                    aspectRatio: SLIDE_ASPECT_RATIO,
                    maxHeight: '100%',
                    maxWidth: '100%',
                    containerType: 'size',
                    ...getBackgroundStyle(slide.background, resolveMediaUrl),
                }}
                onMouseDown={handleCanvasMouseDown}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
            >
                {objects.map((obj) => {
                    const preview = dragPreviewMap.get(obj.id);
                    const displayObj = preview
                        ? {
                              ...obj,
                              x: preview.x,
                              y: preview.y,
                              w: preview.w,
                              h: preview.h,
                              rotation: preview.rotation ?? obj.rotation,
                          }
                        : obj;
                    const commentItems: Array<{ card: CommentCard; entry: CommentEntry | undefined }> = [];
                    for (const cardId of obj.commentCardIds ?? []) {
                        const card = cards?.[cardId];
                        if (!card) continue;
                        const entry = card.chatName ? entries?.find((e) => e.chatName === card.chatName) : undefined;
                        commentItems.push({ card, entry });
                    }
                    const firstUnresolved = commentItems.find(({ entry }) => entry?.status !== 'resolved');
                    return (
                        <SlideObjectView
                            key={obj.id}
                            obj={displayObj}
                            selected={selectedObjectIds.includes(obj.id)}
                            editing={editingObjectId === obj.id}
                            editable={canWrite}
                            isMultiSelected={selectedObjectIds.length > 1 && selectedObjectIds.includes(obj.id)}
                            onSelect={onSelectObject}
                            onStartEditing={onStartEditing}
                            onUpdate={onUpdateObject}
                            onDragStart={handleDragStart}
                            onCopy={onCopyObject}
                            onDelete={onDeleteObject}
                            onMoveUp={onMoveUp}
                            onMoveDown={onMoveDown}
                            onMoveToFront={onMoveToFront}
                            onMoveToBack={onMoveToBack}
                            onAddComment={onAddComment}
                            onCommentClick={onCommentClick}
                            commentColor={
                                firstUnresolved?.card.color ??
                                (firstUnresolved ? EIGEN_STICKIES_COLORS[0][1].value : undefined)
                            }
                            firstCommentCardId={firstUnresolved?.card.id}
                            commentItems={commentItems}
                            onCommentResolve={onCommentResolve}
                            onCommentReopen={onCommentReopen}
                            onCommentChangeColor={onCommentChangeColor}
                            onCommentDelete={onCommentDelete}
                        />
                    );
                })}
                {canWrite &&
                    selectedObjects
                        .filter((o) => o.id !== editingObjectId)
                        .map((obj) => {
                            const preview = dragPreviewMap.get(obj.id);
                            const displayObj = preview
                                ? {
                                      ...obj,
                                      x: preview.x,
                                      y: preview.y,
                                      w: preview.w,
                                      h: preview.h,
                                      rotation: preview.rotation ?? obj.rotation,
                                  }
                                : obj;
                            return (
                                <SelectionChrome
                                    key={`chrome-${obj.id}`}
                                    obj={displayObj}
                                    showRotate={selectedObjectIds.length === 1}
                                    onResizeStart={handleResizeStart}
                                    onRotateStart={handleRotateStart}
                                />
                            );
                        })}
                {dragPreviews.map((p) =>
                    p.rotation === undefined ? null : (
                        <div
                            key={`angle-${p.objId}`}
                            className="absolute z-50 pointer-events-none rounded bg-foreground px-1.5 py-0.5 text-xs text-background"
                            style={{
                                left: `${pxToPercent(p.x + p.w / 2, 'x')}%`,
                                top: `${pxToPercent(p.y, 'y')}%`,
                                transform: 'translate(-50%, -150%)',
                            }}
                        >
                            {Math.round(normalizeAngle(p.rotation))}°
                        </div>
                    ),
                )}
                {activeSnapLines.map((line, i) => (
                    <div
                        key={i}
                        className="absolute pointer-events-none z-50 bg-selection-handle"
                        style={
                            line.orientation === 'vertical'
                                ? { left: `${pxToPercent(line.position, 'x')}%`, top: 0, bottom: 0, width: '1px' }
                                : { top: `${pxToPercent(line.position, 'y')}%`, left: 0, right: 0, height: '1px' }
                        }
                    />
                ))}
                {multiSelectBounds && !dragPreviews.length && (
                    <div
                        className="absolute z-40 border border-dashed border-selection-handle cursor-move"
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
                            'absolute pointer-events-none z-50 border border-selection-handle bg-selection-handle/10',
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
        </div>
    );
}
