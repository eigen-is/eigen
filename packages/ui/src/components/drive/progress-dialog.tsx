import { EigenLoader } from '../braket/eigen-loader';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../dialog';

// Blocking wait dialog for document transforms (exports, conversions): no close
// button — the work is already running server-side and finishes regardless.
export function ProgressDialog({ open, title }: { open: boolean; title: string }) {
    return (
        <Dialog open={open}>
            <DialogContent size="sm" showCloseButton={false}>
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
