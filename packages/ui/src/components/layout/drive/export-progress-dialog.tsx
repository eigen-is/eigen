import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../dialog';
import { Progress } from '../../progress';

export function ExportProgressDialog({ open }: { open: boolean }) {
    return (
        <Dialog open={open}>
            <DialogContent size="sm" showCloseButton={false}>
                <DialogHeader>
                    <DialogTitle>Exporting document</DialogTitle>
                </DialogHeader>
                <div className="py-2">
                    <Progress indicatorClassName="animate-[indeterminate_1.5s_ease-in-out_infinite]" />
                </div>
            </DialogContent>
        </Dialog>
    );
}
