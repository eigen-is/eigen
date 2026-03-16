import {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {RadioGroup, RadioGroupItem} from '@workspace/ui/components/radio-group';
import {Label} from '@workspace/ui/components/label';

export type RecurringAction = 'this' | 'this-and-following' | 'all';

type RecurringActionDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    onConfirm: (action: RecurringAction) => void;
    options?: RecurringAction[];
}

const ACTION_LABELS: Record<RecurringAction, string> = {
    'this': 'This event',
    'this-and-following': 'This and following events',
    'all': 'All events in series',
};

export function RecurringActionDialog({open, onOpenChange, title, onConfirm, options}: RecurringActionDialogProps) {
    const availableOptions = options || (['this', 'this-and-following', 'all'] as RecurringAction[]);
    const [selected, setSelected] = useState<RecurringAction>(availableOptions[0]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="xs">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>

                <RadioGroup
                    value={selected}
                    onValueChange={(v) => setSelected(v as RecurringAction)}
                    className="space-y-2"
                >
                    {availableOptions.map(option => (
                        <div key={option} className="flex items-center gap-2">
                            <RadioGroupItem value={option} id={`recurring-${option}`}/>
                            <Label htmlFor={`recurring-${option}`} className="cursor-pointer">{ACTION_LABELS[option]}</Label>
                        </div>
                    ))}
                </RadioGroup>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button onClick={() => {
                        onConfirm(selected);
                        onOpenChange(false);
                    }}>OK</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
