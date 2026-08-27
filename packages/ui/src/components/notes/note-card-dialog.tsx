import { copyToClipboard } from '@workspace/lib/clipboard';
import { EIGEN_STICKIES_INDICATOR_MAP, isLightColor, lightenColor } from '@workspace/lib/constants';
import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Link as LinkIcon, Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../dialog';
import { Separator } from '../separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';

function IconAction({ icon: Icon, tooltip, onClick }: { icon?: LucideIcon; tooltip?: string; onClick?: () => void }) {
    if (!Icon || !tooltip || !onClick) return null;
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={onClick}
                    className="shrink-0 cursor-pointer opacity-70 hover:opacity-100"
                >
                    <Icon className="size-4" />
                </button>
            </TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
    );
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
    // Rendered between the description and the meta/actions footer — card content,
    // above the separator, unlike `children` (the thread).
    attachments?: ReactNode;
    // In-place edit: when set, replaces the description/attachments/meta rows with an
    // editing form. The colored header and the thread `children` stay visible.
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
    const handleDescriptionClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!canWrite || !onDescriptionChange) return;
        const target = e.target as HTMLElement;
        if (target.tagName !== 'INPUT' || (target as HTMLInputElement).type !== 'checkbox') return;
        const input = target as HTMLInputElement;
        const li = input.closest('li[data-checked]');
        if (!li) return;
        li.setAttribute('data-checked', input.checked ? 'true' : 'false');
        if (input.checked) input.setAttribute('checked', '');
        else input.removeAttribute('checked');
        onDescriptionChange(e.currentTarget.innerHTML);
    };

    const header = (
        <DialogHeader
            className={cn(
                'flex flex-row items-center gap-2 px-4 pt-4 pb-2 rounded-t-lg',
                color &&
                    // Inset shadow, not a border: the color bar must not shift the title.
                    // Dark mode matches the mail list row / NoteCard: 2px inset stripe +
                    // a 14% color-mix wash over --background (see --note-soft below).
                    'bg-(--note-bg) text-(--note-fg) dark:bg-(--note-soft) dark:text-card-foreground dark:shadow-[inset_2px_0_0_0_var(--note-indicator)]',
            )}
            style={
                color
                    ? ({
                          '--note-bg': lightenColor(color, 0.5),
                          '--note-fg': isLightColor(lightenColor(color, 0.5)) ? '#000' : '#fff',
                          '--note-indicator': EIGEN_STICKIES_INDICATOR_MAP.get(color) ?? color,
                          '--note-soft': 'color-mix(in oklab, var(--note-indicator) 14%, var(--background))',
                      } as React.CSSProperties)
                    : undefined
            }
        >
            <DialogTitle className="flex-1">{title}</DialogTitle>
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
                        {/* Header + content cap at 42vh (60% of the 70vh dialog cap) so the thread
                            below always keeps ≥40%. A percentage max-h would never resolve here —
                            the dialog's max-h-[70vh] height stays indefinite. shrink-0 keeps a short
                            body at full height when the thread is long (max-h alone does the cap). */}
                        <div className="flex max-h-[42vh] min-h-0 shrink-0 flex-col">
                            {header}

                            {/* Rendered even when empty, with a floor under it: a title-only card would
                                otherwise drop the body entirely and butt the meta row straight against
                                the colored header. */}
                            <div className="min-h-14 flex-1 overflow-y-auto px-4 py-3 text-sm text-foreground">
                                <div
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
