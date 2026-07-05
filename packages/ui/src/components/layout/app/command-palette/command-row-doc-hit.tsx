import type { PaletteResult } from '@workspace/lib/types/command-palette';
import { CommandItem } from '@workspace/ui/components/command';

type Props = {
    result: Extract<PaletteResult, { kind: 'doc-hit' }>;
    onSelect: () => void;
};

// In-document search hit. Title = the matched text; subtitle (when present) = where it is —
// "Sheet1 · B12", "Slide 3", a column or heading. Enter reveals it in place (no bar).
export function CommandRowDocHit({ result, onSelect }: Props) {
    const { icon: Icon, title, subtitle } = result;
    return (
        <CommandItem onSelect={onSelect} value={result.id}>
            <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="truncate">{title}</span>
            {subtitle && <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{subtitle}</span>}
        </CommandItem>
    );
}
