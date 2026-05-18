import { copyToClipboard } from '@workspace/lib/clipboard';
import { isLightColor, lightenColor } from '@workspace/lib/constants';
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
    meta?: string;
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
    children,
}: NoteCardDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="md" className="max-h-[70vh] flex flex-col p-0 gap-0">
                <div>
                    <DialogHeader
                        className="flex flex-row items-center gap-2 px-4 pt-4 pb-2 rounded-t-lg"
                        style={{
                            backgroundColor: color ? lightenColor(color, 0.5) : undefined,
                            color: color ? (isLightColor(lightenColor(color, 0.5)) ? '#000' : '#fff') : undefined,
                        }}
                    >
                        <DialogTitle className="flex-1">{title}</DialogTitle>
                    </DialogHeader>

                    {description && (
                        <div className="px-4 py-3 text-sm text-foreground">
                            <div
                                className="eigen-prose"
                                onClick={(e) => {
                                    if (!canWrite || !onDescriptionChange) return;
                                    const target = e.target as HTMLElement;
                                    if (target.tagName !== 'INPUT' || (target as HTMLInputElement).type !== 'checkbox')
                                        return;
                                    const input = target as HTMLInputElement;
                                    const li = input.closest('li[data-checked]');
                                    if (!li) return;
                                    li.setAttribute('data-checked', input.checked ? 'true' : 'false');
                                    if (input.checked) input.setAttribute('checked', '');
                                    else input.removeAttribute('checked');
                                    onDescriptionChange(e.currentTarget.innerHTML);
                                }}
                                dangerouslySetInnerHTML={{ __html: description }}
                            />
                        </div>
                    )}

                    {(meta || copyLinkUrl || (canWrite && onEdit) || onAction) && (
                        <div className={cn('flex items-center gap-2 px-4 pb-2', !description && 'pt-2')}>
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
