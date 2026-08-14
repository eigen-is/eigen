import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
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
    const { pending, run, handleOpenChange } = useDialogPending(onOpenChange);

    // Reset to the default scope whenever the dialog (re)opens; the parent keeps this instance mounted.
    // Keyed on `open` only — availableOptions is a fresh array each render when the caller passes a literal.
    useEffect(() => {
        if (open) setSelected(availableOptions[0]);
    }, [open]);

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
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
                    <Button onClick={() => run(() => onConfirm(selected))} disabled={pending}>
                        OK
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
