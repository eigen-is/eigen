// One on/off setting on an admin page, such as an email notification in Server settings: its label and a sentence on
// what it does, with the switch on the right. The label names the switch and the sentence describes it.

import { Label } from '@workspace/ui/components/label';
import { Switch } from '@workspace/ui/components/switch';
import { useId } from 'react';

export function SwitchRow({
    label,
    description,
    checked,
    onChange,
}: {
    label: string;
    description: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    const id = useId();
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
                <Label htmlFor={id}>{label}</Label>
                <p id={`${id}-description`} className="text-xs text-muted-foreground">
                    {description}
                </p>
            </div>
            <Switch id={id} aria-describedby={`${id}-description`} checked={checked} onCheckedChange={onChange} />
        </div>
    );
}
