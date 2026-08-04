import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import { useEffect, useState } from 'react';

export type RecurringAction = 'this' | 'this-and-following' | 'all';

type RecurringActionDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    onConfirm: (action: RecurringAction) => void | Promise<void>;
    options?: RecurringAction[];
};

const ACTION_LABELS: Record<RecurringAction, string> = {
    this: 'This event',
    'this-and-following': 'This and following events',
    all: 'All events in series',
};

export function RecurringActionDialog({ open, onOpenChange, title, onConfirm, options }: RecurringActionDialogProps) {
    const availableOptions = options || (['this', 'this-and-following', 'all'] as RecurringAction[]);
    const [selected, setSelected] = useState<RecurringAction>(availableOptions[0]);
    const [pending, setPending] = useState(false);

    // Reset to the default scope whenever the dialog (re)opens; the parent keeps this instance mounted.
    // Keyed on `open` only — availableOptions is a fresh array each render when the caller passes a literal.
    useEffect(() => {
        if (open) setSelected(availableOptions[0]);
    }, [open]);

    // Own the async lifecycle: disable both actions in-flight (no double-submit), close only after the
    // callback fulfils, and stay open on rejection so the caller's error toast reads with the retry.
    const handleConfirm = async () => {
        if (pending) return;
        setPending(true);
        try {
            await onConfirm(selected);
            onOpenChange(false);
        } catch {
            // Stay open for retry; the mutation's onMutationError already surfaced the toast.
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => (o || !pending) && onOpenChange(o)}>
            <DialogContent size="xs">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>

                <RadioGroup
                    value={selected}
                    onValueChange={(v) => setSelected(v as RecurringAction)}
                    className="space-y-2"
                >
                    {availableOptions.map((option) => (
                        <div key={option} className="flex items-center gap-2">
                            <RadioGroupItem value={option} id={`recurring-${option}`} />
                            <Label htmlFor={`recurring-${option}`} className="cursor-pointer">
                                {ACTION_LABELS[option]}
                            </Label>
                        </div>
                    ))}
                </RadioGroup>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        Cancel
                    </Button>
                    <Button onClick={handleConfirm} disabled={pending}>
                        OK
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
