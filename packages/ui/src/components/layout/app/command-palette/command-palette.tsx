import { useCommandPalette, useCommandResults } from '@workspace/lib/command-palette';
import type { CommandContext, PaletteResult, PaletteScope, Sections } from '@workspace/lib/types/command-palette';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandList } from '@workspace/ui/components/command';
import { Dialog, DialogContent } from '@workspace/ui/components/dialog';
import { cn } from '@workspace/ui/lib/utils';
import type { KeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CommandFooter } from './command-footer';
import { CommandRowAction } from './command-row-action';
import { CommandRowContact } from './command-row-contact';
import { CommandRowMail } from './command-row-mail';
import { CommandRowSmart } from './command-row-smart';

type Props = { ctx: CommandContext };

const SCOPE_CHIPS: Record<PaletteScope, string> = {
    mail: 'Mail',
    actions: 'Actions',
    contacts: 'Contacts',
};

// Tab cycles through scopes. The lookup makes the order obvious at a glance and is
// easier to maintain than a chained ternary.
const NEXT_SCOPE: Record<PaletteScope | 'none', PaletteScope | undefined> = {
    none: 'mail',
    mail: 'actions',
    actions: 'contacts',
    contacts: undefined,
};

// First item the engine produced — the Top Hit if there is one, else the first
// item of the first group. cmdk doesn't re-select on its own when items change, so
// we drive the highlight from here.
function firstResultId(sections: Sections): string | undefined {
    if (sections.topHit) return sections.topHit.id;
    for (const g of sections.groups) {
        if (g.items.length > 0) return g.items[0].id;
    }
    return undefined;
}

export function CommandPalette({ ctx }: Props) {
    const { open, setOpen, input, setInput, scope, setScope } = useCommandPalette();
    const sections = useCommandResults(ctx, input);

    const firstId = useMemo(() => firstResultId(sections), [sections]);
    const [selectedValue, setSelectedValue] = useState<string | undefined>(firstId);
    const listRef = useRef<HTMLDivElement>(null);

    // Reset the highlight to the engine's first item whenever results change. Without
    // this cmdk preserves the previous selection — which after typing means the user's
    // first keystroke leaves the highlight on an unrelated row instead of the Top Hit.
    // Snap the list back to the top so the freshly-selected first item is visible.
    useEffect(() => {
        setSelectedValue(firstId);
        if (listRef.current) listRef.current.scrollTop = 0;
    }, [firstId]);

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Backspace' && scope && (e.target as HTMLInputElement).selectionStart === 0) {
            e.preventDefault();
            setScope(undefined);
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            setScope((prev) => NEXT_SCOPE[prev ?? 'none']);
        }
    };

    useEffect(() => {
        if (!open) {
            setInput('');
            setScope(undefined);
        }
    }, [open, setInput, setScope]);

    const renderResult = (r: PaletteResult) => {
        const onSelect = () => {
            r.run(ctx);
            setOpen(false);
        };
        switch (r.kind) {
            case 'action':
                return <CommandRowAction key={r.id} result={r} onSelect={onSelect} />;
            case 'smart':
                return <CommandRowSmart key={r.id} result={r} onSelect={onSelect} />;
            case 'contact':
                return <CommandRowContact key={r.id} result={r} onSelect={onSelect} />;
            case 'mail':
                return <CommandRowMail key={r.id} result={r} onSelect={onSelect} />;
            default: {
                // Exhaustiveness guard: if a new PaletteResult kind is added without a row
                // component, TypeScript refuses to compile this assignment AND we fail loud
                // at runtime instead of silently rendering nothing.
                const _exhaustive: never = r;
                throw new Error(`Unhandled PaletteResult kind: ${(_exhaustive as PaletteResult).kind}`);
            }
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="overflow-hidden p-0 max-w-xl">
                <Command
                    shouldFilter={false}
                    value={selectedValue}
                    onValueChange={setSelectedValue}
                    className={cn('rounded-md')}
                >
                    <div className="flex items-center gap-2 px-3 pt-2">
                        {scope && <span className="rounded bg-muted px-2 py-0.5 text-xs">{SCOPE_CHIPS[scope]}</span>}
                        <CommandInput
                            value={input}
                            onValueChange={setInput}
                            onKeyDown={handleKeyDown}
                            placeholder="Search and jump anywhere…"
                        />
                    </div>
                    {/* Fixed height keeps the dialog from jumping as the result set shrinks/grows. */}
                    <CommandList ref={listRef} className="h-[420px] max-h-[420px]">
                        <CommandEmpty>No results.</CommandEmpty>
                        {sections.topHit && (
                            <CommandGroup heading="Top Hit">{renderResult(sections.topHit)}</CommandGroup>
                        )}
                        {sections.groups.map((g) => (
                            <CommandGroup key={g.id} heading={g.heading}>
                                {g.items.map(renderResult)}
                            </CommandGroup>
                        ))}
                    </CommandList>
                    <CommandFooter />
                </Command>
            </DialogContent>
        </Dialog>
    );
}
