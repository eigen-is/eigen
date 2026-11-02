// The shared modal dialog, built on Radix: the overlay, the content box with its corner X, and the header, title,
// description and footer parts that dialogs across the apps put inside it. A dialog under an open file preview, such as
// the one the preview was opened from, leaves Escape and a click outside to the preview.

import { Button } from '@workspace/ui/components/button';
import { isLayerAbove } from '@workspace/ui/hooks/use-dialog-open';
import { cn } from '@workspace/ui/lib/utils';
import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useComposedRefs } from 'radix-ui/internal';
import type * as React from 'react';
import { useRef } from 'react';

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
    return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
    return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
    return (
        <DialogPrimitive.Overlay
            data-slot="dialog-overlay"
            className={cn(
                'fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
                className,
            )}
            {...props}
        />
    );
}

type DialogSize = 'xs' | 'sm' | 'md' | 'lg';

const dialogSizeMap: Record<DialogSize, string> = {
    xs: 'sm:max-w-sm',
    sm: 'sm:max-w-md',
    md: 'sm:max-w-lg',
    lg: 'sm:max-w-2xl',
};

// A field that closes something of its own on Escape: a combobox with its list open, or a field that marks itself,
// such as the light editor's link field. Radix hears Escape on the document before the field does, so the dialog has
// to leave the key alone. cmdk's input says expanded always, because its list is the dialog.
const OWNS_ESCAPE = '[role="combobox"][aria-expanded="true"]:not([cmdk-input]), [data-owns-escape]';

// The file preview is no Radix layer, so Radix can't tell a dialog under it from one over it. Every layer portals to
// <body> in the order it opened, so a dialog earlier in the document than the preview is under it, such as the
// Stickies card the preview was opened from.
function isUnderPreview(content: Element | null): boolean {
    const preview = document.querySelector('[data-preview-overlay]');
    return !!preview && !!content && !isLayerAbove(preview, content);
}

function DialogContent({
    className,
    children,
    showCloseButton = true,
    size,
    onPointerDownOutside,
    onEscapeKeyDown,
    ref,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean;
    size?: DialogSize;
}) {
    const contentRef = useRef<HTMLDivElement>(null);
    const composedRef = useComposedRefs(ref, contentRef);

    return (
        <DialogPortal>
            <DialogOverlay />
            <DialogPrimitive.Content
                ref={composedRef}
                data-slot="dialog-content"
                className={cn(
                    // A form taller than the screen scrolls inside the dialog, so its footer stays on screen. A
                    // caller that sets its own height overrides max-h and overflow. The single column may shrink
                    // below its content: an auto column would grow to fit a very long title and push the footer's
                    // buttons out of the dialog.
                    'fixed top-[50%] left-[50%] z-50 grid grid-cols-1 w-full max-w-[calc(100%-2rem)] max-h-[calc(100vh-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
                    size ? dialogSizeMap[size] : 'sm:max-w-xl',
                    className,
                )}
                // A dialog under an open preview stays open on a click outside it: Radix checks each layer on its
                // own, so a click in a picker over the preview counts as outside the dialog under the preview. The
                // preview closes itself when its own overlay is clicked. A dialog above the preview closes alone,
                // as anywhere else, so a click outside New folder over the Save to Drive picker leaves the picker.
                onPointerDownOutside={(e) => {
                    if (isUnderPreview(contentRef.current)) e.preventDefault();
                    onPointerDownOutside?.(e);
                }}
                // Escape over an open preview is the preview's to close, not the dialog's under it. Escape in a
                // field that closes something of its own is that field's.
                onEscapeKeyDown={(e) => {
                    const fieldOwnsEscape = e.target instanceof Element && e.target.matches(OWNS_ESCAPE);
                    if (isUnderPreview(contentRef.current) || fieldOwnsEscape) e.preventDefault();
                    onEscapeKeyDown?.(e);
                }}
                {...props}
            >
                {children}
                {showCloseButton && (
                    <DialogPrimitive.Close
                        data-slot="dialog-close"
                        className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
                    >
                        <XIcon />
                        <span className="sr-only">Close</span>
                    </DialogPrimitive.Close>
                )}
            </DialogPrimitive.Content>
        </DialogPortal>
    );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="dialog-header"
            className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
            {...props}
        />
    );
}

function DialogFooter({
    className,
    showCloseButton = false,
    children,
    ...props
}: React.ComponentProps<'div'> & {
    showCloseButton?: boolean;
}) {
    return (
        <div
            data-slot="dialog-footer"
            className={cn(
                'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end [&_[data-slot=button]:not([data-size^=icon])]:min-w-20',
                className,
            )}
            {...props}
        >
            {children}
            {showCloseButton && (
                <DialogPrimitive.Close asChild>
                    <Button variant="outline">Close</Button>
                </DialogPrimitive.Close>
            )}
        </div>
    );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
    return (
        <DialogPrimitive.Title
            data-slot="dialog-title"
            // The right padding keeps a long title clear of the corner X.
            className={cn('text-lg leading-none font-medium pr-8 break-words', className)}
            {...props}
        />
    );
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
    return (
        <DialogPrimitive.Description
            data-slot="dialog-description"
            className={cn('text-sm text-muted-foreground break-words', className)}
            {...props}
        />
    );
}

export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle };
