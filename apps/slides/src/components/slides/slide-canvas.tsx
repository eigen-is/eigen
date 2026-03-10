import {useCallback, useRef} from 'react';
import {SLIDE_ASPECT_RATIO, SlideItem, SlideObject, pxToPercent} from './types';
import {SlideObjectView} from './slide-object';
import {useObjectDrag} from './hooks/use-object-drag';
import {useSnapTargets} from './hooks/use-snap-lines';

type SlideCanvasProps = {
    slide: SlideItem;
    objects: SlideObject[];
    selectedObjectIds: string[];
    editingObjectId: string | null;
    onSelectObject: (objId: string | null, additive?: boolean) => void;
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
    const canvasRef = useRef<HTMLDivElement>(null);
    const primarySelectedId = selectedObjectIds.length === 1 ? selectedObjectIds[0] : null;
    const {vSnaps, hSnaps} = useSnapTargets(objects, primarySelectedId);

    const {startDrag, activeSnapLines, dragPreview} = useObjectDrag({
        onUpdate: onUpdateObject,
        canvasRef,
        vSnaps,
        hSnaps,
    });

    const handleDragStart = useCallback((e: React.MouseEvent, objId: string, mode: 'move', x: number, y: number, w: number, h: number) => {
        startDrag(e, objId, mode, x, y, w, h);
    }, [startDrag]);

    const handleResizeStart = useCallback((e: React.MouseEvent, objId: string, mode: string, x: number, y: number, w: number, h: number) => {
        startDrag(e, objId, mode as any, x, y, w, h);
    }, [startDrag]);

    const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.target === canvasRef.current) {
            onSelectObject(null);
        }
    }, [onSelectObject]);

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

    return (
        <div className="flex-1 flex items-center justify-center p-6 bg-muted overflow-hidden" onMouseDown={handleOuterMouseDown}>
            <div
                ref={canvasRef}
                className="relative w-full shadow-lg rounded-sm overflow-hidden"
                style={{
                    aspectRatio: SLIDE_ASPECT_RATIO,
                    maxHeight: '100%',
                    maxWidth: '100%',
                    backgroundColor: slide.backgroundColor,
                    ...(slide.backgroundImage ? {backgroundImage: `url(${slide.backgroundImage})`, backgroundSize: 'cover', backgroundPosition: 'center'} : {}),
                }}
                onMouseDown={handleCanvasMouseDown}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
            >
                {objects.map((obj) => {
                    const displayObj = (dragPreview && dragPreview.objId === obj.id)
                        ? {...obj, x: dragPreview.x, y: dragPreview.y, w: dragPreview.w, h: dragPreview.h}
                        : obj;
                    return (
                    <SlideObjectView
                        key={obj.id}
                        obj={displayObj}
                        selected={selectedObjectIds.includes(obj.id)}
                        editing={editingObjectId === obj.id}
                        editable={canWrite}
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
                        className="absolute pointer-events-none z-50"
                        style={line.orientation === 'vertical'
                            ? {left: `${pxToPercent(line.position, 'x')}%`, top: 0, bottom: 0, width: '1px', backgroundColor: '#3b82f6'}
                            : {top: `${pxToPercent(line.position, 'y')}%`, left: 0, right: 0, height: '1px', backgroundColor: '#3b82f6'}
                        }
                    />
                ))}
            </div>
        </div>
    );
}
