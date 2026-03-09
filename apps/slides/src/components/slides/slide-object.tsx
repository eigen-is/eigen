import {memo, useEffect, useRef} from 'react';
import {
    ArrowDownToLine,
    ArrowUpToLine,
    ChevronDown,
    ChevronUp,
    Copy,
    Trash2,
} from 'lucide-react';
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
    editing: boolean;
    editable: boolean;
    onSelect: (objId: string, additive?: boolean) => void;
    onStartEditing: (objId: string) => void;
    onStopEditing: () => void;
    onUpdate: (objId: string, updates: Partial<SlideObject>) => void;
    onDragStart: (e: React.MouseEvent, objId: string, mode: 'move', x: number, y: number, w: number, h: number) => void;
    onResizeStart: (e: React.MouseEvent, objId: string, mode: string, x: number, y: number, w: number, h: number) => void;
    onCopy?: (objId: string) => void;
    onDelete?: (objId: string) => void;
    onMoveUp?: (objId: string) => void;
    onMoveDown?: (objId: string) => void;
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
                                                                 obj,
                                                                 selected,
                                                                 editing,
                                                                 editable,
                                                                 onSelect,
                                                                 onStartEditing,
                                                                 onStopEditing,
                                                                 onUpdate,
                                                                 onDragStart,
                                                                 onResizeStart,
                                                                 onCopy,
                                                                 onDelete,
                                                                 onMoveUp,
                                                                 onMoveDown,
                                                                 onMoveToFront,
                                                                 onMoveToBack,
}: SlideObjectViewProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (editing && textareaRef.current) {
            textareaRef.current.focus();
            textareaRef.current.select();
        }
    }, [editing]);

    const handleMouseDown = (e: React.MouseEvent) => {
        if (editing) return;
        e.stopPropagation();
        const additive = e.metaKey || e.ctrlKey;
        onSelect(obj.id, additive);
        if (editable && !additive) {
            onDragStart(e, obj.id, 'move', obj.x, obj.y, obj.w, obj.h);
        }
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (obj.type === 'text') {
            onStartEditing(obj.id);
        }
    };

    const shadowStr = buildShadowString(obj);

    const textStyle = obj.type === 'text' ? {
        fontSize: `${obj.fontSize / 1080 * 100}vh`,
        fontWeight: obj.fontWeight,
        fontStyle: obj.fontStyle,
        textDecoration: obj.textDecoration !== 'none' ? obj.textDecoration : undefined,
        textAlign: obj.textAlign as React.CSSProperties['textAlign'],
        color: obj.color,
        lineHeight: obj.lineHeight || 1.2,
        letterSpacing: obj.letterSpacing ? `${obj.letterSpacing}px` : undefined,
        textShadow: shadowStr,
    } : undefined;

    const verticalAlign = obj.type === 'text' ? (obj.verticalAlign || 'top') : undefined;

    const objectDiv = (
        <div
            className={`absolute ${selected ? 'ring-2 ring-blue-500' : obj.type === 'text' ? 'border border-dashed border-gray-300' : ''} ${editable && !editing ? 'cursor-move' : 'cursor-default'}`}
            style={{
                left: `${obj.x}%`,
                top: `${obj.y}%`,
                width: `${obj.w}%`,
                height: `${obj.h}%`,
                transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
                transformOrigin: 'center center',
                backgroundColor: obj.type === 'text' && obj.backgroundColor ? obj.backgroundColor : undefined,
                ...(obj.type === 'image' && shadowStr ? {boxShadow: shadowStr} : {}),
            }}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
        >
            {obj.type === 'text' && !editing && (
                <div
                    className="w-full h-full flex overflow-hidden select-none pointer-events-none"
                    style={{
                        alignItems: verticalAlign === 'center' ? 'center' : verticalAlign === 'bottom' ? 'flex-end' : 'flex-start',
                        justifyContent: obj.textAlign === 'center' ? 'center' : obj.textAlign === 'right' ? 'flex-end' : 'flex-start',
                    }}
                >
                    <p className="whitespace-pre-wrap break-words w-full" style={textStyle}>
                        {obj.highlightColor
                            ? <span style={{backgroundColor: obj.highlightColor, boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone'}}>{obj.text}</span>
                            : obj.text
                        }
                    </p>
                </div>
            )}

            {obj.type === 'text' && editing && (
                <div className="w-full h-full flex overflow-hidden" style={{alignItems: verticalAlign === 'center' ? 'center' : verticalAlign === 'bottom' ? 'flex-end' : 'flex-start'}}>
                    <textarea
                        ref={textareaRef}
                        className="w-full resize-none bg-transparent border-none outline-none whitespace-pre-wrap break-words p-0"
                        style={{...textStyle, height: 'auto', maxHeight: '100%'}}
                        rows={1}
                        value={obj.text}
                        onChange={(e) => onUpdate(obj.id, {text: e.target.value})}
                        onBlur={onStopEditing}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') onStopEditing();
                            e.stopPropagation();
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                    />
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

            {selected && editable && !editing && HANDLE_POSITIONS.map(({mode, className}) => (
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
                <ContextMenuItem onClick={() => onMoveUp?.(obj.id)}>
                    <ChevronUp className="h-4 w-4 mr-2"/> Move up
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onMoveDown?.(obj.id)}>
                    <ChevronDown className="h-4 w-4 mr-2"/> Move down
                </ContextMenuItem>
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

function buildShadowString(obj: SlideObject): string | undefined {
    if (!obj.shadowBlur && !obj.shadowOffsetX && !obj.shadowOffsetY) return undefined;
    if (!obj.shadowColor || obj.shadowColor === 'rgba(0,0,0,0)') return undefined;
    return `${obj.shadowOffsetX}px ${obj.shadowOffsetY}px ${obj.shadowBlur}px ${obj.shadowColor}`;
}
