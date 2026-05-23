import { useCommandPalette, useCommandResults } from '@workspace/lib/command-palette';
import type { CommandContext, PaletteResult, PaletteScope } from '@workspace/lib/types/command-palette';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandList } from '@workspace/ui/components/command';
import { Dialog, DialogContent } from '@workspace/ui/components/dialog';
import { cn } from '@workspace/ui/lib/utils';
import type { KeyboardEvent } from 'react';
import { useEffect } from 'react';
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

export function CommandPalette({ ctx }: Props) {
    const { open, setOpen, input, setInput, scope, setScope } = useCommandPalette();
    const sections = useCommandResults(ctx, input);

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Backspace' && scope && (e.target as HTMLInputElement).selectionStart === 0) {
            e.preventDefault();
            setScope(undefined);
            return;
        }
        if (e.key === 'Tab' && !scope) {
            e.preventDefault();
            setScope((prev) =>
                prev === undefined ? 'mail' : prev === 'mail' ? 'actions' : prev === 'actions' ? 'contacts' : undefined,
            );
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
                const _exhaustive: never = r;
                return _exhaustive;
            }
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="overflow-hidden p-0 max-w-xl">
                <Command shouldFilter={false} className={cn('rounded-md')}>
                    <div className="flex items-center gap-2 px-3 pt-2">
                        {scope && <span className="rounded bg-muted px-2 py-0.5 text-xs">{SCOPE_CHIPS[scope]}</span>}
                        <CommandInput
                            value={input}
                            onValueChange={setInput}
                            onKeyDown={handleKeyDown}
                            placeholder="Search and jump anywhere…"
                        />
                    </div>
                    <CommandList>
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
