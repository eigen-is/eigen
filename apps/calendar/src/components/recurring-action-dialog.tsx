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
}

export function RecurringActionDialog({open, onOpenChange, title, onConfirm}: RecurringActionDialogProps) {
    const [selected, setSelected] = useState<RecurringAction>('this');

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
                    <div className="flex items-center gap-2">
                        <RadioGroupItem value="this" id="recurring-this"/>
                        <Label htmlFor="recurring-this" className="cursor-pointer">This event</Label>
                    </div>
                    <div className="flex items-center gap-2">
                        <RadioGroupItem value="this-and-following" id="recurring-following"/>
                        <Label htmlFor="recurring-following" className="cursor-pointer">This and following events</Label>
                    </div>
                    <div className="flex items-center gap-2">
                        <RadioGroupItem value="all" id="recurring-all"/>
                        <Label htmlFor="recurring-all" className="cursor-pointer">All events All events in series</Label>
                    </div>
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
