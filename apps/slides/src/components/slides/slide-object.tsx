import {memo} from 'react';
import {ArrowDownToLine, ArrowUpToLine, Copy, Trash2} from 'lucide-react';
import {SlideObject} from './types';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@workspace/ui/components/context-menu';

type SlideObjectViewProps = {
    obj: SlideObject;
    selected: boolean;
    editable: boolean;
    onSelect: (objId: string) => void;
    onDragStart: (e: React.MouseEvent, objId: string, mode: 'move', x: number, y: number, w: number, h: number) => void;
    onResizeStart: (e: React.MouseEvent, objId: string, mode: string, x: number, y: number, w: number, h: number) => void;
    onDoubleClick: (objId: string) => void;
    onCopy?: (objId: string) => void;
    onDelete?: (objId: string) => void;
    onMoveToFront?: (objId: string) => void;
    onMoveToBack?: (objId: string) => void;
}

const HANDLE_POSITIONS = [
    {mode: 'resize-nw', className: '-top-1.5 -left-1.5 cursor-nwse-resize'},
    {mode: 'resize-ne', className: '-top-1.5 -right-1.5 cursor-nesw-resize'},
    {mode: 'resize-sw', className: '-bottom-1.5 -left-1.5 cursor-nesw-resize'},
    {mode: 'resize-se', className: '-bottom-1.5 -right-1.5 cursor-nwse-resize'},
    {mode: 'resize-n', className: '-top-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize'},
    {mode: 'resize-s', className: '-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize'},
    {mode: 'resize-w', className: 'top-1/2 -left-1.5 -translate-y-1/2 cursor-ew-resize'},
    {mode: 'resize-e', className: 'top-1/2 -right-1.5 -translate-y-1/2 cursor-ew-resize'},
] as const;

export const SlideObjectView = memo(function SlideObjectView({
    obj, selected, editable, onSelect, onDragStart, onResizeStart, onDoubleClick,
    onCopy, onDelete, onMoveToFront, onMoveToBack,
}: SlideObjectViewProps) {
    const handleMouseDown = (e: React.MouseEvent) => {
        e.stopPropagation();
        onSelect(obj.id);
        if (editable) {
            onDragStart(e, obj.id, 'move', obj.x, obj.y, obj.w, obj.h);
        }
    };

    const objectDiv = (
        <div
            className={`absolute ${selected ? 'ring-2 ring-blue-500' : obj.type === 'text' ? 'border border-dashed border-gray-300' : ''} ${editable ? 'cursor-move' : 'cursor-default'}`}
            style={{
                left: `${obj.x}%`,
                top: `${obj.y}%`,
                width: `${obj.w}%`,
                height: `${obj.h}%`,
                transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
            }}
            onMouseDown={handleMouseDown}
            onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick(obj.id); }}
        >
            {obj.type === 'text' && (
                <div
                    className="w-full h-full flex items-center overflow-hidden select-none pointer-events-none"
                    style={{
                        justifyContent: obj.textAlign === 'center' ? 'center' : obj.textAlign === 'right' ? 'flex-end' : 'flex-start',
                    }}
                >
                    <p
                        className="whitespace-pre-wrap break-words w-full"
                        style={{
                            fontSize: `${obj.fontSize / 1080 * 100}vh`,
                            fontWeight: obj.fontWeight,
                            fontStyle: obj.fontStyle,
                            textAlign: obj.textAlign,
                            color: obj.color,
                            lineHeight: 1.2,
                        }}
                    >
                        {obj.text}
                    </p>
                </div>
            )}

            {obj.type === 'image' && (
                <img
                    src={obj.src}
                    className="w-full h-full select-none pointer-events-none"
                    style={{objectFit: obj.objectFit}}
                    draggable={false}
                    alt=""
                />
            )}

            {selected && editable && HANDLE_POSITIONS.map(({mode, className}) => (
                <div
                    key={mode}
                    className={`absolute w-3 h-3 bg-white border-2 border-blue-500 rounded-sm ${className}`}
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        onResizeStart(e, obj.id, mode, obj.x, obj.y, obj.w, obj.h);
                    }}
                />
            ))}
        </div>
    );

    if (!editable) return objectDiv;

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                {objectDiv}
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem onClick={() => onCopy?.(obj.id)}>
                    <Copy className="h-4 w-4 mr-2"/> Copy
                </ContextMenuItem>
                <ContextMenuSeparator/>
                <ContextMenuItem onClick={() => onMoveToFront?.(obj.id)}>
                    <ArrowUpToLine className="h-4 w-4 mr-2"/> Bring to front
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onMoveToBack?.(obj.id)}>
                    <ArrowDownToLine className="h-4 w-4 mr-2"/> Send to back
                </ContextMenuItem>
                <ContextMenuSeparator/>
                <ContextMenuItem variant="destructive" onClick={() => onDelete?.(obj.id)}>
                    <Trash2 className="h-4 w-4 mr-2"/> Delete
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
});
