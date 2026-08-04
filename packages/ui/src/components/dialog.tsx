import { Button } from '@workspace/ui/components/button';
import { cn } from '@workspace/ui/lib/utils';
import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type * as React from 'react';
import { useOptionalPreview } from './layout/preview-provider/preview-provider';

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
    return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
    return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
    return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
    return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
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

function DialogContent({
    className,
    children,
    showCloseButton = true,
    size,
    abovePreview,
    onPointerDownOutside,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean;
    size?: DialogSize;
    abovePreview?: boolean;
}) {
    const preview = useOptionalPreview();

    return (
        <DialogPortal data-slot="dialog-portal">
            <DialogOverlay className={abovePreview ? 'z-[200]' : undefined} />
            <DialogPrimitive.Content
                data-slot="dialog-content"
                className={cn(
                    // max-h + overflow mirror the width cap so a form taller than the viewport
                    // scrolls inside the dialog instead of pushing its footer off-screen. Callers
                    // that manage their own height (flex-col + max-h-[85vh]) override both.
                    'fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] max-h-[calc(100vh-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
                    abovePreview ? 'z-[200]' : undefined,
                    size ? dialogSizeMap[size] : 'sm:max-w-xl',
                    className,
                )}
                // While a preview is open, never let an outside pointer-down close the
                // dialog — Radix's detector fires per layer, so a click inside the
                // save-to-drive picker (portaled to body) registers as "outside" the
                // sticky dialog underneath and would otherwise dismiss it.
                //
                // Only the dialog flagged abovePreview is responsible for closing the
                // preview when its own overlay (which covers the preview) is clicked.
                // For lower-stack dialogs we just preventDefault and let FilePreview's
                // own onClick close the preview when the user taps its overlay directly.
                onPointerDownOutside={(e) => {
                    if (preview?.isPreviewOpen) {
                        e.preventDefault();
                        if (abovePreview) {
                            const target = e.target as HTMLElement;
                            if (!target.closest('[data-preview-overlay]')) {
                                preview.closePreview();
                            }
                        }
                    }
                    onPointerDownOutside?.(e);
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
            // pr-8 reserves space for the absolute-positioned close button so long titles
            // wrap above it instead of running underneath.
            className={cn('text-lg leading-none font-medium pr-8', className)}
            {...props}
        />
    );
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
    return (
        <DialogPrimitive.Description
            data-slot="dialog-description"
            className={cn('text-sm text-muted-foreground', className)}
            {...props}
        />
    );
}

export {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogOverlay,
    DialogPortal,
    DialogTitle,
    DialogTrigger,
};
