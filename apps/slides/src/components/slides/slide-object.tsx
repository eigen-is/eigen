import {memo, useCallback, useEffect, useRef, useState} from 'react';
import {
    AlignCenter,
    AlignLeft,
    AlignRight,
    ArrowDownToLine,
    ArrowUpToLine,
    Bold,
    Copy,
    Italic,
    Minus,
    Palette,
    Plus,
    Strikethrough,
    Trash2,
    Underline,
} from 'lucide-react';
import {SlideObject} from './types';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@workspace/ui/components/context-menu';
import {Popover, PopoverAnchor, PopoverContent, PopoverTrigger} from '@workspace/ui/components/popover';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {Toggle} from '@workspace/ui/components/toggle';
import {ColorPicker} from '@workspace/ui/components/layout/media/color-picker';
import {Separator} from '@workspace/ui/components/separator';

type SlideObjectViewProps = {
    obj: SlideObject;
    selected: boolean;
    editing: boolean;
    editable: boolean;
    onSelect: (objId: string) => void;
    onStartEditing: (objId: string) => void;
    onStopEditing: () => void;
    onUpdate: (objId: string, updates: Partial<SlideObject>) => void;
    onDragStart: (e: React.MouseEvent, objId: string, mode: 'move', x: number, y: number, w: number, h: number) => void;
    onResizeStart: (e: React.MouseEvent, objId: string, mode: string, x: number, y: number, w: number, h: number) => void;
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
                                                                 onMoveToFront,
                                                                 onMoveToBack,
}: SlideObjectViewProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const showLayout = selected && editable && !editing;

    useEffect(() => {
        if (editing && textareaRef.current) {
            textareaRef.current.focus();
            textareaRef.current.select();
        }
    }, [editing]);

    const handleMouseDown = (e: React.MouseEvent) => {
        if (editing) return;
        e.stopPropagation();
        onSelect(obj.id);
        if (editable) {
            onDragStart(e, obj.id, 'move', obj.x, obj.y, obj.w, obj.h);
        }
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (obj.type === 'text') {
            onStartEditing(obj.id);
        }
    };

    const textStyle = obj.type === 'text' ? {
        fontSize: `${obj.fontSize / 1080 * 100}vh`,
        fontWeight: obj.fontWeight,
        fontStyle: obj.fontStyle,
        textDecoration: obj.textDecoration !== 'none' ? obj.textDecoration : undefined,
        textAlign: obj.textAlign as React.CSSProperties['textAlign'],
        color: obj.color,
        lineHeight: 1.2,
    } : undefined;

    const objectDiv = (
        <div
            className={`absolute ${selected ? 'ring-2 ring-blue-500' : obj.type === 'text' ? 'border border-dashed border-gray-300' : ''} ${editable && !editing ? 'cursor-move' : 'cursor-default'}`}
            style={{
                left: `${obj.x}%`,
                top: `${obj.y}%`,
                width: `${obj.w}%`,
                height: `${obj.h}%`,
                transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
            }}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
        >
            {obj.type === 'text' && !editing && (
                <div
                    className="w-full h-full flex items-center overflow-hidden select-none pointer-events-none"
                    style={{
                        justifyContent: obj.textAlign === 'center' ? 'center' : obj.textAlign === 'right' ? 'flex-end' : 'flex-start',
                    }}
                >
                    <p className="whitespace-pre-wrap break-words w-full" style={textStyle}>
                        {obj.text}
                    </p>
                </div>
            )}

            {obj.type === 'text' && editing && (
                <div className="w-full h-full flex items-center overflow-hidden">
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
        <Popover open={showLayout}>
            <ContextMenu>
                <PopoverAnchor asChild>
                    <ContextMenuTrigger asChild>
                        {objectDiv}
                    </ContextMenuTrigger>
                </PopoverAnchor>
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

            <PopoverContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-auto"
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
                {obj.type === 'image' ? (
                    <ImageLayout obj={obj} onUpdate={onUpdate}/>
                ) : (
                    <TextLayout obj={obj} onUpdate={onUpdate}/>
                )}
            </PopoverContent>
        </Popover>
    );
});

function ImageLayout({obj, onUpdate}: {
    obj: SlideObject & { type: 'image' };
    onUpdate: (id: string, u: Partial<SlideObject>) => void
}) {
    return (
        <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Fit</span>
            <Select value={obj.objectFit}
                    onValueChange={(v) => onUpdate(obj.id, {objectFit: v as 'contain' | 'cover' | 'fill'})}>
                <SelectTrigger className="h-8 w-28">
                    <SelectValue/>
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="contain">Contain</SelectItem>
                    <SelectItem value="cover">Cover</SelectItem>
                    <SelectItem value="fill">Fill</SelectItem>
                </SelectContent>
            </Select>
        </div>
    );
}

function TextLayout({obj, onUpdate}: {
    obj: SlideObject & { type: 'text' };
    onUpdate: (id: string, u: Partial<SlideObject>) => void
}) {
    const [colorOpen, setColorOpen] = useState(false);

    const update = useCallback((u: Partial<SlideObject>) => onUpdate(obj.id, u), [obj.id, onUpdate]);

    return (
        <div className="flex flex-col gap-3">
            {/* Font size */}
            <div className="flex items-center gap-1">
                <button className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent"
                        onClick={() => update({fontSize: Math.max(12, obj.fontSize - 4)})}>
                    <Minus className="h-3 w-3"/>
                </button>
                <span className="text-sm w-8 text-center tabular-nums">{obj.fontSize}</span>
                <button className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent"
                        onClick={() => update({fontSize: Math.min(200, obj.fontSize + 4)})}>
                    <Plus className="h-3 w-3"/>
                </button>
            </div>

            <Separator/>

            {/* Style toggles */}
            <div className="flex items-center gap-1">
                <Toggle size="sm" pressed={obj.fontWeight === 'bold'}
                        onPressedChange={(p) => update({fontWeight: p ? 'bold' : 'normal'})}>
                    <Bold className="h-4 w-4"/>
                </Toggle>
                <Toggle size="sm" pressed={obj.fontStyle === 'italic'}
                        onPressedChange={(p) => update({fontStyle: p ? 'italic' : 'normal'})}>
                    <Italic className="h-4 w-4"/>
                </Toggle>
                <Toggle size="sm" pressed={obj.textDecoration === 'underline'}
                        onPressedChange={(p) => update({textDecoration: p ? 'underline' : 'none'})}>
                    <Underline className="h-4 w-4"/>
                </Toggle>
                <Toggle size="sm" pressed={obj.textDecoration === 'line-through'}
                        onPressedChange={(p) => update({textDecoration: p ? 'line-through' : 'none'})}>
                    <Strikethrough className="h-4 w-4"/>
                </Toggle>
            </div>

            {/* Alignment */}
            <div className="flex items-center gap-1">
                <Toggle size="sm" pressed={obj.textAlign === 'left'}
                        onPressedChange={() => update({textAlign: 'left'})}>
                    <AlignLeft className="h-4 w-4"/>
                </Toggle>
                <Toggle size="sm" pressed={obj.textAlign === 'center'}
                        onPressedChange={() => update({textAlign: 'center'})}>
                    <AlignCenter className="h-4 w-4"/>
                </Toggle>
                <Toggle size="sm" pressed={obj.textAlign === 'right'}
                        onPressedChange={() => update({textAlign: 'right'})}>
                    <AlignRight className="h-4 w-4"/>
                </Toggle>
            </div>

            <Separator/>

            {/* Color */}
            <Popover open={colorOpen} onOpenChange={setColorOpen}>
                <PopoverTrigger asChild>
                    <button className="flex items-center gap-2 h-8 px-2 rounded hover:bg-accent text-sm">
                        <Palette className="h-4 w-4"/>
                        <div className="h-4 w-4 rounded-full border border-border"
                             style={{backgroundColor: obj.color}}/>
                        <span>Color</span>
                    </button>
                </PopoverTrigger>
                <PopoverContent side="right" align="start" className="w-auto">
                    <ColorPicker value={obj.color} onChange={(c) => {
                        update({color: c || '#000000'});
                        setColorOpen(false);
                    }} showReset={false}/>
                </PopoverContent>
            </Popover>
        </div>
    );
}
