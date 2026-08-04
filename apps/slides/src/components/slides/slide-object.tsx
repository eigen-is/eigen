import { getBackgroundStyle } from '@workspace/lib/background';
import { getFontFamily } from '@workspace/lib/constants/fonts';
import { isPendingMediaName, useMediaResolver } from '@workspace/lib/drive';
import { escapeHtml } from '@workspace/lib/html';
import { LightEditor } from '@workspace/ui/components/layout/editor';
import { ImagePlaceholder } from '@workspace/ui/components/layout/media/image-placeholder';
import type { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { cn } from '@workspace/ui/lib/utils';
import { memo } from 'react';
import {
    BORDER_RADIUS_ROUND,
    type ImageObject,
    pxToPercent,
    SLIDE_BASE_HEIGHT,
    SLIDE_BASE_WIDTH,
    type SlideObject,
} from './types';

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
        ...(obj.type === 'text' ? getBackgroundStyle(obj.background) : {}),
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

function SlideImage({ obj, url, className }: { obj: ImageObject; url: string | null; className: string }) {
    if (!url && isPendingMediaName(obj.mediaName)) return <ImagePlaceholder />;
    return (
        <img
            src={url || ''}
            className={className}
            style={{ objectFit: obj.objectFit }}
            draggable={false}
            decoding="async"
            alt=""
        />
    );
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
            {obj.type === 'image' && <SlideImage obj={obj} url={imageUrl} className="w-full h-full" />}
        </div>
    );
}

type SlideObjectViewProps = {
    obj: SlideObject;
    selected: boolean;
    editing: boolean;
    editable: boolean;
    isMultiSelected: boolean;
    searchActive?: boolean;
    searchMatched?: boolean;
    onSelect: (objId: string, additive?: boolean) => void;
    onStartEditing: (objId: string) => void;
    onUpdate: (objId: string, updates: Partial<SlideObject>) => void;
    onDragStart: (
        e: React.MouseEvent,
        objId: string,
        mode: 'move',
        x: number,
        y: number,
        w: number,
        h: number,
        rotation: number,
    ) => void;
    onContextMenu?: (e: React.MouseEvent, obj: SlideObject) => void;
    // Stable bind hoisted in SlideCanvas — spread onto the object so a touch long-press opens the menu.
    longPressBind?: ReturnType<typeof useLongPress<SlideObject>>['bind'];
    commentColor?: string | null;
    onCommentClick?: (cardId: string) => void;
    firstCommentCardId?: string | null;
};

export const SlideObjectView = memo(function SlideObjectView({
    obj,
    selected,
    editing,
    editable,
    isMultiSelected,
    searchActive,
    searchMatched,
    onSelect,
    onStartEditing,
    onUpdate,
    onDragStart,
    onContextMenu,
    longPressBind,
    commentColor,
    onCommentClick,
    firstCommentCardId,
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
            onDragStart(e, obj.id, 'move', obj.x, obj.y, obj.w, obj.h, obj.rotation);
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

    return (
        <div
            className={cn(
                'absolute',
                !selected && obj.type === 'text' && 'border border-dashed border-border',
                editable && !editing ? 'cursor-move' : 'cursor-default',
                searchMatched && !searchActive && 'eigen-search-ring',
                searchActive && 'eigen-search-ring-active eigen-search-flash',
            )}
            style={getObjectPositionStyle(obj)}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
            onContextMenu={onContextMenu ? (e) => onContextMenu(e, obj) : undefined}
            {...(longPressBind && !editing ? longPressBind(obj) : {})}
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

            {obj.type === 'image' && (
                <SlideImage obj={obj} url={imageUrl} className="w-full h-full select-none pointer-events-none" />
            )}

            {firstCommentCardId && commentColor && (
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
                        onCommentClick?.(firstCommentCardId);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                />
            )}
        </div>
    );
});
