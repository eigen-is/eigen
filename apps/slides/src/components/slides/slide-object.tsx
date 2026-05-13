import { isLightColor } from '@workspace/lib/constants';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants/colors';
import { getFontFamily } from '@workspace/lib/constants/fonts';
import { isPendingMediaName, useMediaResolver } from '@workspace/lib/drive';
import { escapeHtml } from '@workspace/lib/html';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
} from '@workspace/ui/components/context-menu';
import { LightEditor } from '@workspace/ui/components/layout/editor';
import { ImagePlaceholder } from '@workspace/ui/components/layout/media/image-placeholder';
import {
    ArrowDownToLine,
    ArrowUpToLine,
    Check,
    ChevronDown,
    ChevronUp,
    CircleOff,
    Copy,
    MessageSquarePlus,
    Palette,
    RotateCcw,
    Trash2,
} from 'lucide-react';
import { memo } from 'react';
import { BORDER_RADIUS_ROUND, pxToPercent, SLIDE_BASE_HEIGHT, SLIDE_BASE_WIDTH, type SlideObject } from './types';

function pxToPercentHeight(val: number): string {
    return `${(val / SLIDE_BASE_HEIGHT) * 100}cqh`;
}

function pxToPercentWidth(val: number): string {
    return `${(val / SLIDE_BASE_WIDTH) * 100}cqw`;
}

export function getObjectPositionStyle(obj: SlideObject): React.CSSProperties {
    return {
        left: `${pxToPercent(obj.x, 'x')}%`,
        top: `${pxToPercent(obj.y, 'y')}%`,
        width: `${pxToPercent(obj.w, 'x')}%`,
        height: `${pxToPercent(obj.h, 'y')}%`,
        transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
        transformOrigin: 'center center',
        backgroundColor: obj.type === 'text' && obj.backgroundColor ? obj.backgroundColor : undefined,
        ...(obj.borderWidth && obj.borderColor
            ? { border: `${pxToPercentHeight(obj.borderWidth)} solid ${obj.borderColor}` }
            : {}),
        ...(obj.borderRadius
            ? {
                  borderRadius: obj.borderRadius >= BORDER_RADIUS_ROUND ? '50%' : pxToPercentWidth(obj.borderRadius),
                  overflow: 'hidden' as const,
              }
            : {}),
    };
}

export function getTextStyle(obj: SlideObject & { type: 'text' }): React.CSSProperties {
    return {
        fontFamily: obj.fontFamily ? getFontFamily(obj.fontFamily) : undefined,
        fontSize: pxToPercentHeight(obj.fontSize),
        fontWeight: obj.fontWeight,
        fontStyle: obj.fontStyle,
        textDecoration: obj.textDecoration !== 'none' ? obj.textDecoration : undefined,
        textAlign: obj.textAlign as React.CSSProperties['textAlign'],
        color: obj.color,
        lineHeight: obj.lineHeight || 1.2,
        letterSpacing: obj.letterSpacing ? pxToPercentWidth(obj.letterSpacing) : undefined,
    };
}

export function getVerticalAlignStyle(verticalAlign: string | undefined): React.CSSProperties {
    return {
        alignItems: verticalAlign === 'center' ? 'center' : verticalAlign === 'bottom' ? 'flex-end' : 'flex-start',
    };
}

// TipTap leaves a trailing empty <p></p> behind when the user presses Enter at the end and
// then leaves the field. ProseMirror renders that as a visible blank line in edit mode.
function stripTrailingEmptyBlocks(html: string): string {
    return html.replace(/(?:<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>\s*)+$/gi, '');
}

function buildTextHtml(obj: SlideObject & { type: 'text' }): string {
    const text = stripTrailingEmptyBlocks(obj.text);
    // highlightColor lands inside a style="..." attribute; escape so it can't break out.
    if (!obj.highlightColor) return text;
    return `<span style="background-color:${escapeHtml(obj.highlightColor)};box-decoration-break:clone;-webkit-box-decoration-break:clone">${text}</span>`;
}

export function ReadOnlySlideObject({ obj }: { obj: SlideObject }) {
    const { resolveMediaUrl } = useMediaResolver();
    const vAlign = obj.type === 'text' ? obj.verticalAlign || 'top' : undefined;
    const imageUrl = obj.type === 'image' ? resolveMediaUrl(obj.mediaName) : null;
    return (
        <div className="absolute" style={getObjectPositionStyle(obj)}>
            {obj.type === 'text' && (
                <div className="w-full h-full flex" style={getVerticalAlignStyle(vAlign)}>
                    <div
                        className="slide-text break-words w-full"
                        style={getTextStyle(obj)}
                        dangerouslySetInnerHTML={{ __html: buildTextHtml(obj) }}
                    />
                </div>
            )}
            {obj.type === 'image' &&
                (!imageUrl && isPendingMediaName(obj.mediaName) ? (
                    <ImagePlaceholder />
                ) : (
                    <img
                        src={imageUrl || ''}
                        className="w-full h-full"
                        style={{ objectFit: obj.objectFit }}
                        draggable={false}
                        alt=""
                    />
                ))}
        </div>
    );
}

type SlideObjectViewProps = {
    obj: SlideObject;
    selected: boolean;
    editing: boolean;
    editable: boolean;
    isMultiSelected: boolean;
    onSelect: (objId: string, additive?: boolean) => void;
    onStartEditing: (objId: string) => void;
    onUpdate: (objId: string, updates: Partial<SlideObject>) => void;
    onDragStart: (e: React.MouseEvent, objId: string, mode: 'move', x: number, y: number, w: number, h: number) => void;
    onResizeStart: (
        e: React.MouseEvent,
        objId: string,
        mode: string,
        x: number,
        y: number,
        w: number,
        h: number,
    ) => void;
    onCopy?: (objId: string) => void;
    onDelete?: (objId: string) => void;
    onMoveUp?: (objId: string) => void;
    onMoveDown?: (objId: string) => void;
    onMoveToFront?: (objId: string) => void;
    onMoveToBack?: (objId: string) => void;
    commentColor?: string | null;
    onCommentClick?: (chatName: string) => void;
    firstCommentChatName?: string | null;
    onAddComment?: (objId: string) => void;
    commentEntries?: Array<{ chatName: string; color: string | null; status: 'open' | 'resolved' }>;
    onCommentResolve?: (chatName: string) => void;
    onCommentReopen?: (chatName: string) => void;
    onCommentChangeColor?: (chatName: string, color: string | null) => void;
    onCommentDelete?: (objId: string, chatName: string) => void;
};

const HANDLE_POSITIONS = [
    { mode: 'resize-nw', className: '-top-1.5 -left-1.5 cursor-nwse-resize' },
    { mode: 'resize-ne', className: '-top-1.5 -right-1.5 cursor-nesw-resize' },
    { mode: 'resize-sw', className: '-bottom-1.5 -left-1.5 cursor-nesw-resize' },
    { mode: 'resize-se', className: '-bottom-1.5 -right-1.5 cursor-nwse-resize' },
    { mode: 'resize-n', className: '-top-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize' },
    { mode: 'resize-s', className: '-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize' },
    { mode: 'resize-w', className: 'top-1/2 -left-1.5 -translate-y-1/2 cursor-ew-resize' },
    { mode: 'resize-e', className: 'top-1/2 -right-1.5 -translate-y-1/2 cursor-ew-resize' },
] as const;

export const SlideObjectView = memo(function SlideObjectView({
    obj,
    selected,
    editing,
    editable,
    isMultiSelected,
    onSelect,
    onStartEditing,
    onUpdate,
    onDragStart,
    onResizeStart,
    onCopy,
    onDelete,
    onMoveUp,
    onMoveDown,
    onMoveToFront,
    onMoveToBack,
    commentColor,
    onCommentClick,
    firstCommentChatName,
    onAddComment,
    commentEntries,
    onCommentResolve,
    onCommentReopen,
    onCommentChangeColor,
    onCommentDelete,
}: SlideObjectViewProps) {
    const { resolveMediaUrl } = useMediaResolver();

    const handleMouseDown = (e: React.MouseEvent) => {
        if (editing) return;
        e.stopPropagation();
        const additive = e.metaKey || e.ctrlKey;
        // When clicking an already-selected object in a multi-selection, don't reset selection
        if (!additive && !isMultiSelected) {
            onSelect(obj.id);
        } else if (additive) {
            onSelect(obj.id, true);
        }
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

    const textStyle = obj.type === 'text' ? getTextStyle(obj) : undefined;
    const verticalAlign = obj.type === 'text' ? obj.verticalAlign || 'top' : undefined;
    const imageUrl = obj.type === 'image' ? resolveMediaUrl(obj.mediaName) : null;

    const objectDiv = (
        <div
            className={`absolute ${selected ? 'ring-1 ring-selection-handle' : obj.type === 'text' ? 'border border-dashed border-border' : ''} ${editable && !editing ? 'cursor-move' : 'cursor-default'}`}
            style={getObjectPositionStyle(obj)}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
        >
            {obj.type === 'text' && !editing && (
                <div
                    className="w-full h-full flex overflow-hidden select-none pointer-events-none"
                    style={getVerticalAlignStyle(verticalAlign)}
                >
                    <div
                        className="slide-text break-words w-full"
                        style={textStyle}
                        dangerouslySetInnerHTML={{ __html: buildTextHtml(obj) }}
                    />
                </div>
            )}

            {obj.type === 'text' && editing && (
                <div
                    className="w-full h-full flex overflow-hidden"
                    style={getVerticalAlignStyle(verticalAlign)}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <div className="slide-text w-full max-h-full overflow-hidden" style={textStyle}>
                        <LightEditor
                            content={stripTrailingEmptyBlocks(obj.text)}
                            onChange={(html) => onUpdate(obj.id, { text: stripTrailingEmptyBlocks(html) })}
                            toolbar="floating"
                            proseStyle={false}
                            className="min-h-0 break-words"
                            containerClassName="relative flex flex-col w-full"
                            onReady={({ editor }) => editor.chain().focus('end').run()}
                        />
                    </div>
                </div>
            )}

            {obj.type === 'image' &&
                (!imageUrl && isPendingMediaName(obj.mediaName) ? (
                    <ImagePlaceholder />
                ) : (
                    <img
                        src={imageUrl || ''}
                        className="w-full h-full select-none pointer-events-none"
                        style={{ objectFit: obj.objectFit }}
                        draggable={false}
                        alt=""
                    />
                ))}

            {selected &&
                editable &&
                !editing &&
                HANDLE_POSITIONS.map(({ mode, className }) => (
                    <div
                        key={mode}
                        className={`absolute h-3 w-3 bg-background border border-selection-handle rounded-sm ${className}`}
                        onMouseDown={(e) => {
                            e.stopPropagation();
                            onResizeStart(e, obj.id, mode, obj.x, obj.y, obj.w, obj.h);
                        }}
                    />
                ))}
            {firstCommentChatName && commentColor && (
                <div
                    className="absolute top-0 right-0 cursor-pointer z-10"
                    style={{
                        width: 0,
                        height: 0,
                        borderLeft: '16px solid transparent',
                        borderTop: `16px solid ${commentColor}`,
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        onCommentClick?.(firstCommentChatName);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                />
            )}
        </div>
    );

    if (!editable) return objectDiv;

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{objectDiv}</ContextMenuTrigger>
            <ContextMenuContent className="min-w-48">
                <ContextMenuItem onClick={() => onCopy?.(obj.id)}>
                    <Copy className="h-4 w-4 mr-2" /> Copy
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onMoveUp?.(obj.id)}>
                    <ChevronUp className="h-4 w-4 mr-2" /> Move up
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onMoveDown?.(obj.id)}>
                    <ChevronDown className="h-4 w-4 mr-2" /> Move down
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onMoveToFront?.(obj.id)}>
                    <ArrowUpToLine className="h-4 w-4 mr-2" /> Bring to front
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onMoveToBack?.(obj.id)}>
                    <ArrowDownToLine className="h-4 w-4 mr-2" /> Send to back
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onClick={() => onDelete?.(obj.id)}>
                    <Trash2 className="h-4 w-4 mr-2" /> Delete
                </ContextMenuItem>
                {onAddComment && commentEntries && commentEntries.length === 0 && (
                    <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => onAddComment(obj.id)}>
                            <MessageSquarePlus className="h-4 w-4 mr-2" /> Add comment
                        </ContextMenuItem>
                    </>
                )}
                {commentEntries &&
                    commentEntries.length === 1 &&
                    (() => {
                        const entry = commentEntries[0];
                        return (
                            <>
                                <ContextMenuSeparator />
                                <ContextMenuItem onClick={() => onCommentClick?.(entry.chatName)}>
                                    <MessageSquarePlus className="h-4 w-4 mr-2" /> View comment
                                </ContextMenuItem>
                                <ContextMenuSub>
                                    <ContextMenuSubTrigger className="gap-2">
                                        <Palette className="h-4 w-4 mr-2" /> Comment color
                                    </ContextMenuSubTrigger>
                                    <ContextMenuSubContent>
                                        <div className="flex gap-1 p-2">
                                            <button
                                                type="button"
                                                className="h-4 w-4 rounded-full border border-border hover:scale-125 transition-transform flex items-center justify-center bg-background"
                                                title="No color"
                                                onClick={() => onCommentChangeColor?.(entry.chatName, null)}
                                            >
                                                <CircleOff className="h-2.5 w-2.5 text-muted-foreground" />
                                            </button>
                                            {EIGEN_STICKIES_COLORS[0].map((c) => (
                                                <button
                                                    type="button"
                                                    key={c.value}
                                                    className="h-4 w-4 rounded-full border border-border/50 hover:scale-125 transition-transform flex items-center justify-center"
                                                    style={{ backgroundColor: c.value }}
                                                    title={c.label}
                                                    onClick={() => onCommentChangeColor?.(entry.chatName, c.value)}
                                                >
                                                    {entry.color === c.value && (
                                                        <Check
                                                            className="h-2 w-2"
                                                            style={{
                                                                color: isLightColor(c.value) ? '#000' : '#fff',
                                                            }}
                                                        />
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    </ContextMenuSubContent>
                                </ContextMenuSub>
                                {entry.status === 'open' ? (
                                    <ContextMenuItem onClick={() => onCommentResolve?.(entry.chatName)}>
                                        <Check className="h-4 w-4 mr-2" /> Resolve comment
                                    </ContextMenuItem>
                                ) : (
                                    <ContextMenuItem onClick={() => onCommentReopen?.(entry.chatName)}>
                                        <RotateCcw className="h-4 w-4 mr-2" /> Reopen comment
                                    </ContextMenuItem>
                                )}
                                <ContextMenuItem
                                    variant="destructive"
                                    onClick={() => onCommentDelete?.(obj.id, entry.chatName)}
                                >
                                    <Trash2 className="h-4 w-4 mr-2" /> Delete comment
                                </ContextMenuItem>
                            </>
                        );
                    })()}
            </ContextMenuContent>
        </ContextMenu>
    );
});
