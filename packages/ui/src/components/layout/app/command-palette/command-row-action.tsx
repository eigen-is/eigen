import type { PaletteResult } from '@workspace/lib/types/command-palette';
import { CommandItem, CommandShortcut } from '@workspace/ui/components/command';

type Props = {
    result: Extract<PaletteResult, { kind: 'action' }>;
    onSelect: () => void;
};

export function CommandRowAction({ result, onSelect }: Props) {
    const { icon: Icon } = result;
    return (
        <CommandItem onSelect={onSelect} value={result.id}>
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1">{result.title}</span>
            {result.subtitle && <span className="text-xs text-muted-foreground">{result.subtitle}</span>}
            {result.shortcut && <CommandShortcut>{result.shortcut}</CommandShortcut>}
        </CommandItem>
    );
}
