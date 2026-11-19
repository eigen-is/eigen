// A card's title in its dialog's header. A writer clicks it to edit it in place: Enter or clicking away saves, and an
// emptied or unchanged title writes nothing. The dialog cancels the edit on Esc or its close button. The dialog that
// adds a card types its title into the same input.

import { Pencil } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn, SOFT_HOVER_REVEAL_CLASS } from '../../lib/utils';
import { DialogTitle } from '../dialog';

type CardTitleProps = {
    title: string;
    canWrite: boolean;
    editing: boolean;
    onEdit: () => void;
    onSave: (title: string | null) => void;
};

export function CardTitle({ title, canWrite, editing, onEdit, onSave }: CardTitleProps) {
    if (editing) {
        const save = (value: string) => {
            const next = value.trim();
            onSave(next && next !== title ? next : null);
        };
        return (
            <>
                <DialogTitle className="sr-only">{title}</DialogTitle>
                <CardTitleInput
                    autoFocus
                    defaultValue={title}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        save(e.currentTarget.value);
                    }}
                    onBlur={(e) => save(e.currentTarget.value)}
                />
            </>
        );
    }
    if (!canWrite) return <DialogTitle className="py-1.5 pr-0">{title}</DialogTitle>;
    return (
        <DialogTitle className="min-w-0 flex-1 pr-0">
            <button
                type="button"
                onClick={onEdit}
                className="group -mx-1.5 flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left pointer-fine:hover:bg-current/10"
            >
                <span className="min-w-0 break-words">{title}</span>
                <Pencil className={cn('h-3.5 w-3.5 shrink-0', SOFT_HOVER_REVEAL_CLASS)} />
            </button>
        </DialogTitle>
    );
}

// Sized like the title it replaces, so starting an edit moves nothing.
export function CardTitleInput({ className, ...props }: ComponentProps<'input'>) {
    return (
        <input
            aria-label="Title"
            className={cn(
                '-mx-1.5 w-full min-w-0 rounded-md bg-background/70 px-1.5 py-1.5 text-lg leading-none font-medium text-foreground outline-none ring-1 ring-current/25 placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                className,
            )}
            {...props}
        />
    );
}
