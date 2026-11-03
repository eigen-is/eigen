// The command palette every app opens with Cmd+K: the search input with its scope chip, and the result sections
// the engine built for the query.

import { parseQuery, useCommandPalette, useCommandResults } from '@workspace/lib/command-palette';
import type { CommandContext, PaletteResult, PaletteScope, Sections } from '@workspace/lib/types/command-palette';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandList } from '@workspace/ui/components/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@workspace/ui/components/dialog';
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

// The order Tab cycles through the scopes. `doc` comes first because it is the most specific, but it exists only
// while a document is open, so Tab skips it otherwise.
const NEXT_SCOPE: Record<PaletteScope | 'none', PaletteScope | undefined> = {
    none: 'doc',
    doc: 'file',
    file: 'mail',
    mail: 'actions',
    actions: 'contacts',
    contacts: 'help',
    help: undefined,
};

// The row to highlight: the Top hit if there is one, else the first row of the first group. cmdk keeps its old
// highlight when the rows change, so the palette sets it itself.
function firstResultId(sections: Sections): string | undefined {
    if (sections.topHit) return sections.topHit.id;
    for (const group of sections.groups) {
        if (group.items.length > 0) return group.items[0].id;
    }
    return undefined;
}

export function CommandPalette({ ctx }: Props) {
    const { open, setOpen, input, setInput, scope, setScope } = useCommandPalette();
    const sections = useCommandResults(ctx, input, scope);

    // Typing the `doc:` prefix reaches that scope even with no document open, so the empty list says what to do.
    const docScopeNoDoc = (parseQuery(input).scope ?? scope) === 'doc' && !ctx.docSearch;

    const firstId = useMemo(() => firstResultId(sections), [sections]);
    const [selectedValue, setSelectedValue] = useState<string | undefined>(firstId);
    const listRef = useRef<HTMLDivElement>(null);

    // Typing changes the rows, and the highlight goes back to the first one, scrolled into view. Otherwise the first
    // key typed would leave it on an unrelated row instead of the Top hit.
    useEffect(() => {
        setSelectedValue(firstId);
        if (listRef.current) listRef.current.scrollTop = 0;
    }, [firstId]);

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Backspace' && scope && e.currentTarget.selectionStart === 0) {
            e.preventDefault();
            setScope(undefined);
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            setScope((prev) => {
                const next = NEXT_SCOPE[prev ?? 'none'];
                return next === 'doc' && !ctx.docSearch ? NEXT_SCOPE.doc : next;
            });
        }
    };

    // The input and scope reset when the palette opens, not when it closes. A row that navigates to another app
    // keeps its query on screen until the page changes, instead of flashing the Suggested list as the dialog closes.
    const wasOpenRef = useRef(false);
    useEffect(() => {
        if (open && !wasOpenRef.current) {
            setInput('');
            setScope(undefined);
        }
        wasOpenRef.current = open;
    }, [open, setInput, setScope]);

    const renderResult = (result: PaletteResult) => {
        const onSelect = () => {
            result.run(ctx);
            setOpen(false);
        };
        switch (result.kind) {
            case 'action':
                return <CommandRowAction key={result.id} result={result} onSelect={onSelect} />;
            case 'smart':
                return <CommandRowSmart key={result.id} result={result} onSelect={onSelect} />;
            case 'contact':
                return <CommandRowContact key={result.id} result={result} onSelect={onSelect} />;
            case 'mail':
                return <CommandRowMail key={result.id} result={result} onSelect={onSelect} />;
            case 'file':
                return <CommandRowFile key={result.id} result={result} onSelect={onSelect} />;
            case 'doc-hit':
                return <CommandRowDocHit key={result.id} result={result} onSelect={onSelect} />;
            case 'doc-comment-hit':
                return <CommandRowDocCommentHit key={result.id} result={result} onSelect={onSelect} />;
            case 'help':
                return <CommandRowHelp key={result.id} result={result} onSelect={onSelect} />;
            default: {
                // A new kind of result without a row fails to compile here, and fails loudly if it gets through.
                const unhandled: never = result;
                throw new Error(`Unhandled palette result: ${JSON.stringify(unhandled)}`);
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
                    // The gutter sits inside the list's scroller, so the results clear the overlay scrollbar. Each
                    // group reaches back out by its items' padding, so an item's text lines up with the search icon.
                    className="[&_[data-slot=command-group]]:-mx-2 [&_[data-slot=command-group]]:px-0 [&_[data-slot=command-input-wrapper]]:px-(--app-gutter-x)"
                >
                    {scope && (
                        <div className="flex items-center gap-2 app-gutter-x pt-2">
                            <span className="rounded bg-muted px-2 py-0.5 text-xs">{SCOPE_CHIPS[scope]}</span>
                        </div>
                    )}
                    <CommandInput
                        value={input}
                        onValueChange={setInput}
                        onKeyDown={handleKeyDown}
                        placeholder="Search and jump anywhere…"
                    />
                    {/* A fixed height keeps the dialog still while the number of results changes. */}
                    <CommandList ref={listRef} className="h-[420px] max-h-[420px] app-gutter-x">
                        <CommandEmpty>
                            {docScopeNoDoc ? 'Open a document to search inside it' : 'No results.'}
                        </CommandEmpty>
                        {sections.topHit && (
                            <CommandGroup heading="Top hit">{renderResult(sections.topHit)}</CommandGroup>
                        )}
                        {sections.groups.map((group) => (
                            <CommandGroup key={group.id} heading={group.heading}>
                                {group.items.map(renderResult)}
                            </CommandGroup>
                        ))}
                    </CommandList>
                    <CommandFooter />
                </Command>
            </DialogContent>
        </Dialog>
    );
}
