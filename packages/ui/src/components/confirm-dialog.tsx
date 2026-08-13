import type { ReactNode } from 'react';
import { useState } from 'react';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';

export type ConfirmDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: ReactNode;
    onConfirm: () => void | Promise<void>;
    cancelText?: string;
    confirmText?: string;
    destructive?: boolean;
};

export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    onConfirm,
    cancelText = 'Cancel',
    confirmText = 'Confirm',
    destructive = false,
}: ConfirmDialogProps) {
    const [pending, setPending] = useState(false);

    // Own the async lifecycle: disable both actions in-flight (no double-submit), close only after
    // the callback fulfils, and stay open on rejection so the caller's error toast reads with the retry.
    const handleConfirm = async () => {
        if (pending) return;
        setPending(true);
        try {
            await onConfirm();
            onOpenChange(false);
        } catch {
            // Stay open for retry; the mutation's onMutationError already surfaced the toast.
        } finally {
            setPending(false);
        }
    };

    return (
        // While pending, ignore every close path (Escape/backdrop/X) so the retry surface survives;
        // opening is always allowed.
        <Dialog open={open} onOpenChange={(o) => (o || !pending) && onOpenChange(o)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        {cancelText}
                    </Button>
                    <Button
                        variant={destructive ? 'destructive' : 'default'}
                        onClick={handleConfirm}
                        disabled={pending}
                    >
                        {confirmText}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
