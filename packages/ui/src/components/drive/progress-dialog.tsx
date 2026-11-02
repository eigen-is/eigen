// The blocking wait dialog for a document transform, such as an export or a conversion. It has no close button: the
// work already runs on the server and finishes either way.

import { EigenLoader } from '../braket/eigen-loader';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../dialog';

export function ProgressDialog({ open, title }: { open: boolean; title: string }) {
    return (
        <Dialog open={open}>
            <DialogContent size="sm" showCloseButton={false} aria-describedby={undefined}>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                <div className="flex justify-center py-2">
                    <EigenLoader className="text-2xl" />
                </div>
            </DialogContent>
        </Dialog>
    );
}
