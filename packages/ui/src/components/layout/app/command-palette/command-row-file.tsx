import type { PaletteResult } from '@workspace/lib/types/command-palette';
import { CommandItem } from '@workspace/ui/components/command';

type Props = {
    result: Extract<PaletteResult, { kind: 'file' }>;
    onSelect: () => void;
};

// Single-line file row. The provider already supplies the proper mime-aware icon
// via getFilePresentation (same source as the Drive table) and a display name
// with the eigen extension stripped.
export function CommandRowFile({ result, onSelect }: Props) {
    const { icon: Icon, title } = result;
    return (
        <CommandItem onSelect={onSelect} value={result.id}>
            <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="truncate">{title}</span>
        </CommandItem>
    );
}
