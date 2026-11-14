// The dialog a sticky card or a comment card opens into: its colored header, the description, the
// attachments, a meta row with actions and, below, the card's thread. A reader with write access can tick
// the boxes of a task list in the description without opening the editor, and ticking the last box of a
// list now and then celebrates. Callers such as CardDialog fill in the card's own content and actions.

import { copyToClipboard } from '@workspace/lib/clipboard';
import { EIGEN_STICKIES_INDICATOR_MAP, lightenColor, readableTextColor } from '@workspace/lib/constants/colors';
import { countTaskItems } from '@workspace/lib/html';
import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Link as LinkIcon, Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { useCelebrate } from '../celebrate/use-celebrate';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../dialog';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { Separator } from '../separator';

function IconAction({ icon: Icon, tooltip, onClick }: { icon?: LucideIcon; tooltip?: string; onClick?: () => void }) {
    if (!Icon || !tooltip || !onClick) return null;
    return <TooltipButton icon={Icon} tooltipText={tooltip} className="h-7 w-7 shrink-0" onClick={onClick} />;
}

type NoteCardDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    meta?: ReactNode;
    color?: string | null;
    canWrite?: boolean;
    onEdit?: () => void;
    actionIcon?: LucideIcon;
    actionTooltip?: string;
    onAction?: () => void;
    copyLinkUrl?: string;
    // Fires after a read-only task-list checkbox toggle inside `description`.
    // Receives the post-toggle HTML. Only wired when `canWrite` is true.
    onDescriptionChange?: (html: string) => void;
    // Card content between the description and the footer, so it sits above the separator, unlike the thread
    // in `children`.
    attachments?: ReactNode;
    // Replaces the description, attachments and meta rows with an editing form. The colored header and the
    // thread in `children` stay visible.
    editForm?: ReactNode;
    children: ReactNode;
};

export function NoteCardDialog({
    open,
    onOpenChange,
    title,
    description,
    meta,
    color,
    canWrite,
    onEdit,
    actionIcon,
    actionTooltip,
    onAction,
    copyLinkUrl,
    onDescriptionChange,
    attachments,
    editForm,
    children,
}: NoteCardDialogProps) {
    const celebrate = useCelebrate();
    // One try per opening: the chance is rolled once, so unticking and re-ticking the last box can't farm it.
    const celebratedRef = useRef(false);
    // The parent draws the saved description again, which replaces every box in the page. So the celebration
    // waits for that and starts from the box at the same place in the list, as the clicked one is gone by then.
    const descriptionRef = useRef<HTMLDivElement>(null);
    const celebrateBoxRef = useRef<number | null>(null);
    // A tick whose save never came back must not celebrate a later edit, such as a peer's, so a close disarms it.
    useEffect(() => {
        if (open) celebratedRef.current = false;
        else celebrateBoxRef.current = null;
    }, [open]);
    useEffect(() => {
        const index = celebrateBoxRef.current;
        if (index === null) return;
        celebrateBoxRef.current = null;
        const box = descriptionRef.current?.querySelectorAll('input[type="checkbox"]')[index];
        if (box instanceof HTMLElement) celebrate(box);
    }, [description]);

    const handleDescriptionClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!canWrite || !onDescriptionChange) return;
        const input = e.target;
        if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;
        const li = input.closest('li[data-checked]');
        if (!li) return;
        li.setAttribute('data-checked', input.checked ? 'true' : 'false');
        if (input.checked) input.setAttribute('checked', '');
        else input.removeAttribute('checked');
        const html = e.currentTarget.innerHTML;
        const { checked, total } = countTaskItems(html);
        // A checklist of one item is a toggle, not a list.
        if (total >= 2 && checked === total && !celebratedRef.current) {
            celebratedRef.current = true;
            celebrateBoxRef.current = [...e.currentTarget.querySelectorAll('input[type="checkbox"]')].indexOf(input);
        }
        onDescriptionChange(html);
    };

    const header = (
        <DialogHeader
            className={cn(
                'flex flex-row items-center gap-2 px-4 pt-4 pb-2 rounded-t-lg',
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
            <DialogTitle className="flex-1">{title}</DialogTitle>
            {/* Radix requires a description on every DialogContent; the body below is the card itself. */}
            <DialogDescription className="sr-only">Card details, attachments and replies.</DialogDescription>
        </DialogHeader>
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="md" className="max-h-[70vh] flex flex-col p-0 gap-0">
                {editForm ? (
                    // Edit mode: form only under the header, thread hidden. The form fills the
                    // remaining height and scrolls internally on short viewports.
                    <div className="flex min-h-0 flex-1 flex-col">
                        {header}
                        {/* px-6/pb-6 restores the standard DialogContent padding this p-0 shell strips. */}
                        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">{editForm}</div>
                    </div>
                ) : (
                    <>
                        {/* 42vh is 60% of the dialog's 70vh, so the thread keeps the rest. A percentage
                            would never resolve, as the dialog's own height stays indefinite. */}
                        <div className="flex max-h-[42vh] min-h-0 shrink-0 flex-col">
                            {header}

                            {/* Rendered even when empty, so a title-only card keeps a gap between the
                                colored header and the meta row. */}
                            <div className="min-h-14 flex-1 overflow-y-auto px-4 py-3 text-sm text-foreground">
                                <div
                                    ref={descriptionRef}
                                    className="eigen-prose"
                                    onClick={handleDescriptionClick}
                                    dangerouslySetInnerHTML={{ __html: description ?? '' }}
                                />
                            </div>

                            {attachments && <div className="shrink-0 px-4 pb-3">{attachments}</div>}

                            {(meta || copyLinkUrl || (canWrite && onEdit) || onAction) && (
                                // min-h-8 keeps the row height identical whether the assignee shows
                                // "Unassigned" text or an avatar chip, so assigning never shifts the dialog.
                                <div className="flex min-h-8 shrink-0 items-center gap-2 px-4 pt-1 pb-2">
                                    {/* min-w-0 lets long meta shrink/truncate so the shrink-0 icons stay on-screen at phone widths. */}
                                    {meta && <p className="min-w-0 flex-1 text-xs text-muted-foreground">{meta}</p>}
                                    {copyLinkUrl && (
                                        <IconAction
                                            icon={LinkIcon}
                                            tooltip="Copy link"
                                            onClick={() => copyToClipboard(copyLinkUrl, 'Link copied to clipboard')}
                                        />
                                    )}
                                    {canWrite && onEdit && <IconAction icon={Pencil} tooltip="Edit" onClick={onEdit} />}
                                    <IconAction icon={actionIcon} tooltip={actionTooltip} onClick={onAction} />
                                </div>
                            )}
                        </div>

                        <Separator />

                        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
