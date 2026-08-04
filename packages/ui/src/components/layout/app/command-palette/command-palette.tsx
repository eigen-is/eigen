import { parseQuery, useCommandPalette, useCommandResults } from '@workspace/lib/command-palette';
import type { CommandContext, PaletteResult, PaletteScope, Sections } from '@workspace/lib/types/command-palette';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandList } from '@workspace/ui/components/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@workspace/ui/components/dialog';
import { cn } from '@workspace/ui/lib/utils';
import type { KeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CommandFooter } from './command-footer';
import { CommandRowAction } from './command-row-action';
import { CommandRowContact } from './command-row-contact';
import { CommandRowDocCommentHit } from './command-row-doc-comment-hit';
import { CommandRowDocHit } from './command-row-doc-hit';
import { CommandRowFile } from './command-row-file';
import { CommandRowHelp } from './command-row-help';
import { CommandRowMail } from './command-row-mail';
import { CommandRowSmart } from './command-row-smart';

type Props = { ctx: CommandContext };

const SCOPE_CHIPS: Record<PaletteScope, string> = {
    mail: 'Mail',
    file: 'Files',
    doc: 'In document',
    actions: 'Actions',
    contacts: 'Contacts',
    help: 'Help',
};

// Tab cycles through scopes. The lookup makes the order obvious at a glance and is easier to
// maintain than a chained ternary. `doc` is offered first (most contextual) but only when a
// document is open — the Tab handler skips it otherwise (see handleKeyDown).
const NEXT_SCOPE: Record<PaletteScope | 'none', PaletteScope | undefined> = {
    none: 'doc',
    doc: 'file',
    file: 'mail',
    mail: 'actions',
    actions: 'contacts',
    contacts: 'help',
    help: undefined,
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
    const sections = useCommandResults(ctx, input, scope);

    // The `doc:` scope is reachable by typing the prefix even with no document open (the Tab
    // stop is gated, the prefix isn't). Guide the user instead of a bare "No results.".
    const docScopeNoDoc = (parseQuery(input).scope ?? scope) === 'doc' && !ctx.docSearch;

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
            setScope((prev) => {
                const next = NEXT_SCOPE[prev ?? 'none'];
                // `doc` only exists while a document is open (a controller is published). With
                // none, skip past it so Tab never lands on an empty scope.
                return next === 'doc' && !ctx.docSearch ? NEXT_SCOPE.doc : next;
            });
        }
    };

    // Reset the input/scope when the palette OPENS, not when it closes. Resetting on
    // close means the dialog re-renders with empty input during its close animation —
    // for an Enter-driven action that navigates (window.location.href), the user sees
    // the "Suggested" empty-input flash before the page swaps. Clearing on open keeps
    // the typed query visible until the dialog actually unmounts.
    const wasOpenRef = useRef(false);
    useEffect(() => {
        if (open && !wasOpenRef.current) {
            setInput('');
            setScope(undefined);
        }
        wasOpenRef.current = open;
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
            case 'file':
                return <CommandRowFile key={r.id} result={r} onSelect={onSelect} />;
            case 'doc-hit':
                return <CommandRowDocHit key={r.id} result={r} onSelect={onSelect} />;
            case 'doc-comment-hit':
                return <CommandRowDocCommentHit key={r.id} result={r} onSelect={onSelect} />;
            case 'help':
                return <CommandRowHelp key={r.id} result={r} onSelect={onSelect} />;
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
                {/* Radix requires a title for the dialog to be accessible; both are visually hidden. */}
                <DialogTitle className="sr-only">Command palette</DialogTitle>
                <DialogDescription className="sr-only">Search and jump to anything across your apps.</DialogDescription>
                <Command
                    shouldFilter={false}
                    value={selectedValue}
                    onValueChange={setSelectedValue}
                    className={cn('rounded-md')}
                >
                    {scope && (
                        <div className="flex items-center gap-2 px-3 pt-2">
                            <span className="rounded bg-muted px-2 py-0.5 text-xs">{SCOPE_CHIPS[scope]}</span>
                        </div>
                    )}
                    <CommandInput
                        value={input}
                        onValueChange={setInput}
                        onKeyDown={handleKeyDown}
                        placeholder="Search and jump anywhere…"
                    />
                    {/* Fixed height keeps the dialog from jumping as the result set shrinks/grows. */}
                    <CommandList ref={listRef} className="h-[420px] max-h-[420px]">
                        <CommandEmpty>
                            {docScopeNoDoc ? 'Open a document to search inside it' : 'No results.'}
                        </CommandEmpty>
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
