import { lightenColor } from '@workspace/lib/constants';
import type { LucideIcon } from 'lucide-react';
import { Pencil } from 'lucide-react';
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
    children,
}: NoteCardDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="md" className="max-h-[70vh] flex flex-col p-0 gap-0">
                <div>
                    <DialogHeader
                        className="flex flex-row items-center gap-2 px-4 pt-4 pb-2 rounded-t-lg"
                        style={{ backgroundColor: color ? lightenColor(color, 0.5) : undefined }}
                    >
                        <DialogTitle className="flex-1">{title}</DialogTitle>
                    </DialogHeader>

                    {description && (
                        <div className="px-4 py-3 text-sm text-foreground">
                            <p className="whitespace-pre-line">{description}</p>
                        </div>
                    )}

                    {(meta || (canWrite && onEdit) || onAction) && (
                        <div className={`flex items-center px-4 pb-2 ${!description ? 'pt-2' : ''}`}>
                            {meta && <p className="flex-1 text-xs text-muted-foreground">{meta}</p>}
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
