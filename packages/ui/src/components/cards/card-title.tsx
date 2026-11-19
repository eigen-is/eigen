// A card's title in its dialog's header. A writer's pencil beside it, as on a chat message, edits it in place: Enter or
// clicking away saves, and an emptied or unchanged title writes nothing. The dialog cancels the edit on Esc or its close button. The dialog that
// adds a card types its title into the same input.

import { Pencil } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useRef } from 'react';
import { cn, SOFT_HOVER_REVEAL_CLASS } from '../../lib/utils';
import { DialogTitle } from '../dialog';
import { TooltipButton } from '../layout/toolbar/tooltip-button';

type CardTitleProps = {
    title: string;
    canWrite: boolean;
    editing: boolean;
    onEdit: () => void;
    onSave: (title: string | null) => void;
};

export function CardTitle({ title, canWrite, editing, onEdit, onSave }: CardTitleProps) {
    if (editing) {
        return (
            <>
                <DialogTitle className="sr-only">{title}</DialogTitle>
                <TitleEditor initial={title} onSave={onSave} />
            </>
        );
    }
    if (!canWrite) return <DialogTitle className="py-1.5 pr-0">{title}</DialogTitle>;
    return (
        <DialogTitle className="group flex min-w-0 flex-1 items-center gap-1 pr-0">
            <span className="min-w-0 break-words py-1.5">{title}</span>
            <TooltipButton
                icon={Pencil}
                tooltipText="Edit title"
                className={cn('h-7 w-7 shrink-0 text-current hover:bg-current/10', SOFT_HOVER_REVEAL_CLASS)}
                onClick={onEdit}
            />
        </DialogTitle>
    );
}

function TitleEditor({ initial, onSave }: { initial: string; onSave: (title: string | null) => void }) {
    // The title as the field opened with it, so a peer's rename meanwhile isn't undone by a click in and out.
    const baseline = useRef(initial);
    const save = (value: string) => {
        const next = value.trim();
        onSave(next && next !== baseline.current ? next : null);
    };
    return (
        <CardTitleInput
            autoFocus
            defaultValue={initial}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
                // An input method's Enter confirms the word being composed.
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                e.preventDefault();
                save(e.currentTarget.value);
            }}
            onBlur={(e) => save(e.currentTarget.value)}
        />
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
