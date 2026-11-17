// The quick preview lightbox: the full-screen overlay that shows one item of a group bigger, with a title bar and its
// close button, a round previous and next button at either side, the item in the middle and an optional bar of
// actions under it. A file's quick look fills it with the file and its actions, and the public site with a picture or
// film from a page. It is a Radix dialog, so it stacks with a dialog it opens over and one opened over it.

import { useHotkey } from '@tanstack/react-hotkeys';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { useRef } from 'react';
import { useFocusReturn } from '../hooks/use-focus-return';

// The room the two bars leave, which a body sizes itself to.
export const PREVIEW_BODY_MAX_HEIGHT = 'calc(100vh - 7rem)';

type PreviewLightboxProps = {
    title: ReactNode;
    // The group's neighbours: neither, and the item is alone, so no side buttons show.
    hasPrev: boolean;
    hasNext: boolean;
    onPrev: () => void;
    onNext: () => void;
    onClose: () => void;
    footer?: ReactNode;
    children: ReactNode;
};

export function PreviewLightbox({
    title,
    hasPrev,
    hasNext,
    onPrev,
    onNext,
    onClose,
    footer,
    children,
}: PreviewLightboxProps) {
    const contentRef = useRef<HTMLDivElement>(null);
    // A layer above the lightbox, such as Save to Drive or a menu, holds the focus while it is open, so a key pressed
    // outside the lightbox is that layer's. Escape is left to Radix, which closes the top layer.
    const fromLightbox = (event: KeyboardEvent) =>
        event.target instanceof Node && contentRef.current?.contains(event.target) === true;
    // A focused film or sound keeps the keys: an arrow seeks it and Space plays it.
    const onMedia = (event: KeyboardEvent) =>
        event.target instanceof HTMLElement && event.target.closest('video, audio') !== null;
    // Space on a focused control is that control's own activation, so the lib may prevent no default of its own: it
    // does that before the callback runs, and a pressed button would never press.
    useHotkey(
        'Space',
        (event) => {
            if (!fromLightbox(event) || onMedia(event)) return;
            if (event.target instanceof HTMLElement && event.target.closest('button, a[href]')) return;
            event.preventDefault();
            onClose();
        },
        { preventDefault: false },
    );
    const goPrev = (event: KeyboardEvent) => {
        if (hasPrev && fromLightbox(event) && !onMedia(event)) onPrev();
    };
    const goNext = (event: KeyboardEvent) => {
        if (hasNext && fromLightbox(event) && !onMedia(event)) onNext();
    };
    useHotkey('ArrowLeft', goPrev);
    useHotkey('ArrowUp', goPrev);
    useHotkey('ArrowRight', goNext);
    useHotkey('ArrowDown', goNext);

    const returnFocus = useFocusReturn(contentRef);
    const grouped = hasPrev || hasNext;

    return (
        <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 animate-in fade-in" />
                <DialogPrimitive.Content
                    ref={contentRef}
                    data-slot="preview-lightbox"
                    aria-describedby={undefined}
                    className="fixed inset-0 z-50 flex flex-col animate-in fade-in outline-none"
                    // Space closes the lightbox, so the focus goes to the lightbox itself rather than to its first button.
                    onOpenAutoFocus={(e) => {
                        e.preventDefault();
                        contentRef.current?.focus();
                    }}
                    onCloseAutoFocus={returnFocus}
                    // React passes a click in a dialog the lightbox opened, such as Save to Drive, up to here too.
                    onClick={(e) => {
                        if (e.target === e.currentTarget) onClose();
                    }}
                >
                    <div
                        className="flex items-center justify-between gap-4 px-4 py-2 bg-black/40 text-white shrink-0"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <DialogPrimitive.Title className="truncate text-sm font-medium">{title}</DialogPrimitive.Title>
                        <button
                            type="button"
                            onClick={onClose}
                            title="Close (Esc)"
                            aria-label="Close (Esc)"
                            className="p-1.5 rounded hover:bg-white/20 transition-colors"
                        >
                            <X className="size-4" />
                        </button>
                    </div>

                    <div
                        className="relative flex-1 flex items-center justify-center overflow-hidden min-h-0"
                        onClick={onClose}
                        style={{ cursor: 'zoom-out' }}
                    >
                        <div
                            className="max-w-[90vw] flex items-center justify-center"
                            onClick={(e) => e.stopPropagation()}
                            style={{ maxHeight: PREVIEW_BODY_MAX_HEIGHT, cursor: 'default' }}
                        >
                            {children}
                        </div>
                        {grouped && (
                            <>
                                <SideButton side="left" onClick={onPrev} disabled={!hasPrev} title="Previous (←)">
                                    <ChevronLeft className="size-5" />
                                </SideButton>
                                <SideButton side="right" onClick={onNext} disabled={!hasNext} title="Next (→)">
                                    <ChevronRight className="size-5" />
                                </SideButton>
                            </>
                        )}
                    </div>

                    {footer && (
                        <div
                            className="flex items-center justify-center gap-2 px-4 py-2 bg-black/40 shrink-0"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {footer}
                        </div>
                    )}
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}

// White on the dark backdrop, not theme tokens, like the bars' buttons: the backdrop is dark in either theme.
function SideButton({
    side,
    onClick,
    disabled,
    title,
    children,
}: {
    side: 'left' | 'right';
    onClick: () => void;
    disabled: boolean;
    title: string;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
            disabled={disabled}
            title={title}
            aria-label={title}
            className={cn(
                'absolute top-1/2 -translate-y-1/2 flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition-colors hover:bg-white/20 disabled:opacity-30 disabled:cursor-default disabled:hover:bg-white/10',
                side === 'left' ? 'left-4' : 'right-4',
            )}
        >
            {children}
        </button>
    );
}
