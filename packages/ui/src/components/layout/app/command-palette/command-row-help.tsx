import type { PaletteResult } from '@workspace/lib/types/command-palette';
import { CommandItem } from '@workspace/ui/components/command';

type Props = {
    result: Extract<PaletteResult, { kind: 'help' }>;
    onSelect: () => void;
};

// Help-article row: title on top, the Pagefind excerpt beneath. The excerpt is trusted
// build-time HTML with <mark> match highlights — recoloured from the browser default
// yellow to the per-app soft accent (--app-current-color-soft), matching the index app's
// /support search results.
export function CommandRowHelp({ result, onSelect }: Props) {
    const { payload, icon: Icon, title } = result;
    return (
        <CommandItem onSelect={onSelect} value={result.id} className="items-start">
            <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground truncate">{title}</div>
                <div
                    className="mt-0.5 line-clamp-2 text-xs text-muted-foreground [&_mark]:bg-[var(--app-current-color-soft)] [&_mark]:text-foreground"
                    dangerouslySetInnerHTML={{ __html: payload.excerpt }}
                />
            </div>
        </CommandItem>
    );
}
