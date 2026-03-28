import {Button} from './../../button';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from './../../dialog';

export type DeleteDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: string;
    itemName?: string;
    onDelete: () => void;
    cancelText?: string;
    deleteText?: string;
};

export function DeleteDialog({
                                 open,
                                 onOpenChange,
                                 title,
                                 description,
                                 itemName,
                                 onDelete,
                                 cancelText = 'Cancel',
                                 deleteText = 'Delete',
                             }: DeleteDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        {itemName ? (
                            <>
                                {description} <strong>{itemName}</strong>
                            </>
                        ) : (
                            description
                        )}
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        {cancelText}
                    </Button>
                    <Button variant="destructive" onClick={onDelete}>
                        {deleteText}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
