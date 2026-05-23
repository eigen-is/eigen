import { formatDate } from '@workspace/lib/date';
import type { PaletteResult } from '@workspace/lib/types/command-palette';
import { CommandItem } from '@workspace/ui/components/command';

type Props = {
    result: Extract<PaletteResult, { kind: 'mail' }>;
    onSelect: () => void;
};

export function CommandRowMail({ result, onSelect }: Props) {
    const { payload, icon: Icon } = result;
    return (
        <CommandItem onSelect={onSelect} value={result.id}>
            <Icon className="h-4 w-4 text-muted-foreground" />
            <div className="flex flex-col flex-1 min-w-0">
                <span className="truncate">{result.title}</span>
                <span className="text-xs text-muted-foreground truncate">
                    {payload.fromShort || payload.fromAddress}
                </span>
            </div>
            <span className="text-xs text-muted-foreground ml-auto">{formatDate(payload.date)}</span>
        </CommandItem>
    );
}
