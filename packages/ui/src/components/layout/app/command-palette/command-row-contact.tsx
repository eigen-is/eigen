import type { PaletteResult } from '@workspace/lib/types/command-palette';
import { CommandItem } from '@workspace/ui/components/command';

type Props = {
    result: Extract<PaletteResult, { kind: 'contact' }>;
    onSelect: () => void;
};

export function CommandRowContact({ result, onSelect }: Props) {
    const { icon: Icon } = result;
    return (
        <CommandItem onSelect={onSelect} value={result.id}>
            <Icon className="h-4 w-4 text-muted-foreground" />
            <div className="flex flex-col flex-1 min-w-0">
                <span className="truncate">{result.title}</span>
                {result.subtitle && <span className="text-xs text-muted-foreground truncate">{result.subtitle}</span>}
            </div>
        </CommandItem>
    );
}
