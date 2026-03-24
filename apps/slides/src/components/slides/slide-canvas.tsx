import {useCallback, useMemo, useRef} from 'react';
import {pxToPercent, SLIDE_ASPECT_RATIO, SlideItem, SlideObject} from './types';
import {SlideObjectView} from './slide-object';
import {useMediaResolver} from '@workspace/lib/drive';
import {useObjectDrag} from './hooks/use-object-drag';
import {useSnapTargets} from './hooks/use-snap-lines';
import {useMarqueeSelect} from './hooks/use-marquee-select';

type SlideCanvasProps = {
    slide: SlideItem;
    objects: SlideObject[];
    selectedObjectIds: string[];
    editingObjectId: string | null;
    onSelectObject: (objId: string | null, additive?: boolean) => void;
    onSelectObjects: (objIds: string[]) => void;
    onStartEditing: (objId: string) => void;
    onStopEditing: () => void;
    onUpdateObject: (objId: string, updates: Partial<SlideObject>) => void;
    onDropImage?: (file: File) => void;
    onCopyObject?: (objId: string) => void;
    onDeleteObject?: (objId: string) => void;
    onMoveUp?: (objId: string) => void;
    onMoveDown?: (objId: string) => void;
    onMoveToFront?: (objId: string) => void;
    onMoveToBack?: (objId: string) => void;
    canWrite: boolean;
}

export function SlideCanvas({
                                slide,
                                objects,
                                selectedObjectIds,
                                editingObjectId,
                                onSelectObject,
                                onSelectObjects,
                                onStartEditing,
                                onStopEditing,
                                onUpdateObject,
                                onDropImage,
                                onCopyObject,
                                onDeleteObject,
                                onMoveUp,
                                onMoveDown,
                                onMoveToFront,
                                onMoveToBack,
                                canWrite
                            }: SlideCanvasProps) {
    const {resolveMediaUrl} = useMediaResolver();
    const bgUrl = slide.backgroundMediaName ? resolveMediaUrl(slide.backgroundMediaName) : null;
    const canvasRef = useRef<HTMLDivElement>(null);
    const {vSnaps, hSnaps} = useSnapTargets(objects, selectedObjectIds);

    const selectedObjects = useMemo(() =>
        objects.filter(o => selectedObjectIds.includes(o.id)),
    [objects, selectedObjectIds]);

    const multiSelectBounds = useMemo(() => {
        if (selectedObjects.length < 2) return null;
        const minX = Math.min(...selectedObjects.map(o => o.x));
        const minY = Math.min(...selectedObjects.map(o => o.y));
        const maxX = Math.max(...selectedObjects.map(o => o.x + o.w));
        const maxY = Math.max(...selectedObjects.map(o => o.y + o.h));
        return {x: minX, y: minY, w: maxX - minX, h: maxY - minY};
    }, [selectedObjects]);

    const {startDrag, startGroupDrag, activeSnapLines, dragPreviews} = useObjectDrag({
        onUpdate: onUpdateObject,
        canvasRef,
        vSnaps,
        hSnaps,
    });

    const {marquee, startMarquee} = useMarqueeSelect({
        objects,
        canvasRef,
        onSelect: onSelectObjects,
    });

    const handleDragStart = useCallback((e: React.MouseEvent, objId: string, mode: 'move', x: number, y: number, w: number, h: number) => {
        if (mode === 'move' && multiSelectBounds && selectedObjectIds.includes(objId)) {
            startGroupDrag(e, selectedObjects, multiSelectBounds);
        } else {
            startDrag(e, objId, mode, x, y, w, h);
        }
    }, [startDrag, startGroupDrag, selectedObjectIds, selectedObjects, multiSelectBounds]);

    const handleResizeStart = useCallback((e: React.MouseEvent, objId: string, mode: string, x: number, y: number, w: number, h: number) => {
        startDrag(e, objId, mode as any, x, y, w, h);
    }, [startDrag]);

    const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.target === canvasRef.current) {
            onSelectObject(null);
            if (canWrite) {
                startMarquee(e);
            }
        }
    }, [onSelectObject, canWrite, startMarquee]);

    const handleBoundsMouseDown = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        if (canWrite && multiSelectBounds) {
            startGroupDrag(e, selectedObjects, multiSelectBounds);
        }
    }, [canWrite, startGroupDrag, selectedObjects, multiSelectBounds]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        if (files.length === 0 || !onDropImage) return;
        for (const file of files) {
            onDropImage(file);
        }
    }, [onDropImage]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    }, []);

    const handleOuterMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onSelectObject(null);
        }
    }, [onSelectObject]);

    const dragPreviewMap = useMemo(() => {
        const map = new Map<string, {x: number; y: number; w: number; h: number}>();
        for (const p of dragPreviews) {
            map.set(p.objId, p);
        }
        return map;
    }, [dragPreviews]);

    return (
        <div className="flex-1 flex items-center justify-center p-6 bg-muted overflow-hidden" onMouseDown={handleOuterMouseDown}>
            <div
                ref={canvasRef}
                className="relative w-full shadow-lg rounded-sm overflow-hidden"
                style={{
                    aspectRatio: SLIDE_ASPECT_RATIO,
                    maxHeight: '100%',
                    maxWidth: '100%',
                    containerType: 'size',
                    backgroundColor: slide.backgroundColor,
                    ...(bgUrl ? {backgroundImage: `url(${bgUrl})`, backgroundSize: 'cover', backgroundPosition: 'center'} : {}),
                }}
                onMouseDown={handleCanvasMouseDown}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
            >
                {objects.map((obj) => {
                    const preview = dragPreviewMap.get(obj.id);
                    const displayObj = preview
                        ? {...obj, x: preview.x, y: preview.y, w: preview.w, h: preview.h}
                        : obj;
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
                        onStopEditing={onStopEditing}
                        onUpdate={onUpdateObject}
                        onDragStart={handleDragStart}
                        onResizeStart={handleResizeStart}
                        onCopy={onCopyObject}
                        onDelete={onDeleteObject}
                        onMoveUp={onMoveUp}
                        onMoveDown={onMoveDown}
                        onMoveToFront={onMoveToFront}
                        onMoveToBack={onMoveToBack}
                    />
                    );
                })}
                {activeSnapLines.map((line, i) => (
                    <div
                        key={i}
                        className="absolute pointer-events-none z-50 bg-blue-500"
                        style={line.orientation === 'vertical'
                            ? {left: `${pxToPercent(line.position, 'x')}%`, top: 0, bottom: 0, width: '1px'}
                            : {top: `${pxToPercent(line.position, 'y')}%`, left: 0, right: 0, height: '1px'}
                        }
                    />
                ))}
                {multiSelectBounds && !dragPreviews.length && (
                    <div
                        className="absolute z-40 border border-dashed border-blue-500 cursor-move"
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
                        className="absolute pointer-events-none z-50 border border-blue-500 bg-blue-500/10"
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
