import { Button } from '@workspace/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';

type ConflictDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onOverwrite: () => void;
    onReload: () => void;
    onDownload: () => void;
};

export function ConflictDialog({ open, onOpenChange, onOverwrite, onReload, onDownload }: ConflictDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>File conflict</DialogTitle>
                    <DialogDescription>
                        This file was modified since you opened it. What would you like to do?
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={onDownload}>
                        Download your version
                    </Button>
                    <Button variant="outline" onClick={onReload}>
                        Reload server version
                    </Button>
                    <Button onClick={onOverwrite}>Overwrite</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
