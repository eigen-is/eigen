import { Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../dialog';
import { Separator } from '../../separator';
import { TooltipButton } from '../toolbar/tooltip-button';

type NoteCardDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    meta?: string;
    canWrite?: boolean;
    onEdit?: () => void;
    children: ReactNode;
};

export function NoteCardDialog({
    open,
    onOpenChange,
    title,
    description,
    meta,
    canWrite,
    onEdit,
    children,
}: NoteCardDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="md" className="max-h-[70vh] flex flex-col p-0 gap-0">
                <DialogHeader className="flex flex-row items-center gap-2 px-4 pt-4 pb-2">
                    <DialogTitle className="flex-1">{title}</DialogTitle>
                </DialogHeader>

                {description && (
                    <div className="px-4 py-3 text-sm text-foreground">
                        <p className="whitespace-pre-line">{description}</p>
                    </div>
                )}

                {(meta || (canWrite && onEdit)) && (
                    <div className="flex items-center px-4 pb-1">
                        {meta && <p className="flex-1 text-xs text-muted-foreground">{meta}</p>}
                        {canWrite && onEdit && (
                            <TooltipButton icon={Pencil} tooltipText="Edit" onClick={onEdit} className="h-7 w-7" />
                        )}
                    </div>
                )}

                <Separator className="my-2" />

                {children}
            </DialogContent>
        </Dialog>
    );
}
