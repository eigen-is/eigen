import { copyToClipboard } from '@workspace/lib/clipboard';
import { EIGEN_STICKIES_INDICATOR_MAP, isLightColor, lightenColor } from '@workspace/lib/constants';
import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Link as LinkIcon, Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../dialog';
import { Separator } from '../../separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../tooltip';

function IconAction({ icon: Icon, tooltip, onClick }: { icon?: LucideIcon; tooltip?: string; onClick?: () => void }) {
    if (!Icon || !tooltip || !onClick) return null;
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" onClick={onClick} className="cursor-pointer opacity-70 hover:opacity-100">
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

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="md" className="max-h-[70vh] flex flex-col p-0 gap-0">
                <div>
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
                                      '--note-soft':
                                          'color-mix(in oklab, var(--note-indicator) 14%, var(--background))',
                                  } as React.CSSProperties)
                                : undefined
                        }
                    >
                        <DialogTitle className="flex-1">{title}</DialogTitle>
                    </DialogHeader>

                    {description && (
                        <div className="px-4 py-3 text-sm text-foreground">
                            <div
                                className="eigen-prose"
                                onClick={handleDescriptionClick}
                                dangerouslySetInnerHTML={{ __html: description }}
                            />
                        </div>
                    )}

                    {attachments && <div className={cn('px-4 pb-3', !description && 'pt-2')}>{attachments}</div>}

                    {(meta || copyLinkUrl || (canWrite && onEdit) || onAction) && (
                        <div
                            className={cn('flex items-center gap-2 px-4 pb-2', !description && !attachments && 'pt-2')}
                        >
                            {meta && <p className="flex-1 text-xs text-muted-foreground">{meta}</p>}
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

                {children}
            </DialogContent>
        </Dialog>
    );
}
