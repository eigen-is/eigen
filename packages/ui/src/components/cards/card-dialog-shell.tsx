// The frame of a card's dialog, both the one that adds a card and the one that opens it: a header in the card's color
// with the title and a close button, the card's own column with a footer, and, once the card exists, its thread beside
// it on a wide screen or below it on a phone. While something typed is unsaved, Esc and the close button cancel it
// rather than close the dialog, which gives a phone a way back without an Esc key, and a click outside closes nothing.

import { EIGEN_STICKIES_INDICATOR_MAP, lightenColor, readableTextColor } from '@workspace/lib/constants/colors';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader } from '../dialog';
import { TooltipButton } from '../layout/toolbar/tooltip-button';

type CardDialogShellProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    color?: string;
    // Holds a DialogTitle in every state, so the dialog keeps its name.
    title: ReactNode;
    // An open edit, or a new card's fields once anything is typed.
    unsaved: boolean;
    onCancel: () => void;
    footer: ReactNode;
    thread?: ReactNode;
    children: ReactNode;
};

export function CardDialogShell({
    open,
    onOpenChange,
    color,
    title,
    unsaved,
    onCancel,
    footer,
    thread,
    children,
}: CardDialogShellProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className={cn(
                    'flex flex-col gap-0 overflow-hidden p-0',
                    thread ? 'h-[min(85dvh,44rem)] max-sm:h-[calc(100dvh-2rem)] sm:max-w-4xl' : 'sm:max-w-lg',
                )}
                // A field that owns Escape, such as the link field of the description's toolbar, has taken it already.
                onEscapeKeyDown={(e) => {
                    if (e.defaultPrevented || !unsaved) return;
                    e.preventDefault();
                    onCancel();
                }}
                // The press outside takes the focus from an open edit, and that saves it.
                onInteractOutside={(e) => {
                    if (unsaved) e.preventDefault();
                }}
            >
                <DialogHeader
                    className={cn(
                        'flex shrink-0 flex-row items-center gap-2 space-y-0 rounded-t-lg py-2 pr-2 pl-4',
                        color &&
                            // An inset shadow, not a border, so the color bar doesn't shift the title. In dark mode
                            // the header looks like a mail list row: a 2px stripe over a faint wash of the color.
                            'bg-(--note-bg) text-(--note-fg) dark:bg-(--note-soft) dark:text-card-foreground dark:shadow-[inset_2px_0_0_0_var(--note-indicator)]',
                    )}
                    style={
                        color
                            ? {
                                  '--note-bg': lightenColor(color, 0.5),
                                  '--note-fg': readableTextColor(lightenColor(color, 0.5)),
                                  '--note-indicator': EIGEN_STICKIES_INDICATOR_MAP.get(color) ?? color,
                                  '--note-soft': 'color-mix(in oklab, var(--note-indicator) 14%, var(--background))',
                              }
                            : undefined
                    }
                >
                    <div className="flex min-w-0 flex-1 items-center gap-2">{title}</div>
                    {/* Radix requires a description on every DialogContent; the body below is the card itself. */}
                    <DialogDescription className="sr-only">Card details, attachments and replies.</DialogDescription>
                    {/* It keeps the focus where it is, or an open edit would lose it, and save, before the cancel. */}
                    <TooltipButton
                        icon={X}
                        tooltipText={unsaved ? 'Cancel' : 'Close'}
                        preventFocusLoss
                        className="text-current hover:bg-current/10"
                        onClick={() => (unsaved ? onCancel() : onOpenChange(false))}
                    />
                </DialogHeader>
                <div className={cn('flex min-h-0 flex-1 flex-col', thread && 'md:flex-row')}>
                    <div
                        className={cn(
                            'flex min-h-0 flex-col',
                            thread && 'max-md:max-h-[45%] max-md:shrink-0 md:flex-1 md:border-r',
                        )}
                    >
                        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4">{children}</div>
                        <div className="shrink-0 px-4 pb-3">{footer}</div>
                    </div>
                    {thread && <div className="flex min-h-0 flex-1 flex-col max-md:border-t">{thread}</div>}
                </div>
            </DialogContent>
        </Dialog>
    );
}
