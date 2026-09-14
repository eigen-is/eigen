import { EigenLoader } from '../braket/eigen-loader';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../dialog';
import { useOptionalPreview } from '../preview-provider/preview-context';

// Blocking wait dialog for document transforms (exports, conversions): no close
// button — the work is already running server-side and finishes regardless.
export function ProgressDialog({ open, title }: { open: boolean; title: string }) {
    // A conversion started from the preview overlay's footer has to show above it.
    const preview = useOptionalPreview();

    return (
        <Dialog open={open}>
            <DialogContent size="sm" showCloseButton={false} abovePreview={preview?.isPreviewOpen}>
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
