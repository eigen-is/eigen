import { copyToClipboard } from '@workspace/lib/clipboard';
import { Copy } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './button';
import { Input } from './input';
import { Label } from './label';

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
            <Button
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard(value, successMessage)}
                title="Copy to clipboard"
            >
                <Copy className="h-4 w-4" />
            </Button>
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
