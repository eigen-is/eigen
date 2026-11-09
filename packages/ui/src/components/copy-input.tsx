// A read-only field with a button that copies its value, optionally under a label, for a value someone pastes
// elsewhere, such as an address or a generated password.

import { copyToClipboard } from '@workspace/lib/clipboard';
import { Copy } from 'lucide-react';
import { cn } from '../lib/utils';
import { Input } from './input';
import { Label } from './label';
import { TooltipButton } from './layout/toolbar/tooltip-button';

type CopyInputProps = {
    value: string;
    label?: string;
    inputClassName?: string;
    successMessage?: string;
};

export function CopyInput({ value, label, inputClassName, successMessage }: CopyInputProps) {
    const row = (
        <div className="flex items-center gap-2">
            <Input
                readOnly
                value={value}
                className={cn('font-mono text-sm', inputClassName)}
                onClick={(e) => e.currentTarget.select()}
            />
            <TooltipButton
                icon={Copy}
                tooltipText="Copy to clipboard"
                className="shrink-0"
                onClick={() => copyToClipboard(value, successMessage)}
            />
        </div>
    );

    if (!label) return row;

    return (
        <div className="space-y-1">
            <Label className="text-muted-foreground text-xs">{label}</Label>
            {row}
        </div>
    );
}
