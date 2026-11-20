// A sticky or comment card as it reads when opened: its title and description on a block in the card's color, its
// attachments and a meta line, such as who created it. A reader with write access can tick the boxes of a task list in
// the description without opening the editor, and ticking the last box of a list now and then celebrates. It is the
// lead of the card's thread, so it scrolls with the replies in any host, such as the card dialog.

import { EIGEN_STICKIES_INDICATOR_MAP, lightenColor, readableTextColor } from '@workspace/lib/constants/colors';
import { countTaskItems } from '@workspace/lib/html';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { useCelebrate } from '../celebrate/use-celebrate';

type NoteCardContentProps = {
    title: string;
    description?: string;
    color?: string | null;
    canWrite?: boolean;
    // Fires after a task-list checkbox toggle inside `description`, with the toggled HTML.
    onDescriptionChange?: (html: string) => void;
    attachments?: ReactNode;
    meta?: ReactNode;
};

export function NoteCardContent({
    title,
    description,
    color,
    canWrite,
    onDescriptionChange,
    attachments,
    meta,
}: NoteCardContentProps) {
    const celebrate = useCelebrate();
    // One roll per opening, so re-ticking the last box can't farm it. The refs die with the card, which also disarms a
    // tick whose save never came back.
    const celebratedRef = useRef(false);
    // The parent draws the saved description again, which replaces every box in the page. So the celebration waits for
    // that and starts from the box at the same place in the list, as the clicked one is gone by then.
    const descriptionRef = useRef<HTMLDivElement>(null);
    const celebrateBoxRef = useRef<number | null>(null);
    useEffect(() => {
        const index = celebrateBoxRef.current;
        if (index === null) return;
        celebrateBoxRef.current = null;
        const box = descriptionRef.current?.querySelectorAll('input[type="checkbox"]')[index];
        if (box instanceof HTMLElement) celebrate(box);
    }, [description]);

    const handleDescriptionClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!canWrite || !onDescriptionChange) return;
        const input = e.target;
        if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;
        const li = input.closest('li[data-checked]');
        if (!li) return;
        li.setAttribute('data-checked', input.checked ? 'true' : 'false');
        if (input.checked) input.setAttribute('checked', '');
        else input.removeAttribute('checked');
        const html = e.currentTarget.innerHTML;
        const { checked, total } = countTaskItems(html);
        // A checklist of one item is a toggle, not a list.
        if (total >= 2 && checked === total && !celebratedRef.current) {
            celebratedRef.current = true;
            celebrateBoxRef.current = [...e.currentTarget.querySelectorAll('input[type="checkbox"]')].indexOf(input);
        }
        onDescriptionChange(html);
    };

    return (
        <div className="app-gutter-x flex flex-col gap-3 pt-1 pb-4">
            <div
                className={cn(
                    'rounded-lg px-4 py-3',
                    color
                        ? // In dark mode the block looks like a mail list row: a 2px stripe over a faint wash of the color.
                          'bg-(--note-bg) text-(--note-fg) dark:bg-(--note-soft) dark:text-card-foreground dark:shadow-[inset_2px_0_0_0_var(--note-indicator)]'
                        : 'bg-muted text-foreground',
                )}
                style={
                    color
                        ? {
                              '--note-bg': lightenColor(color, 0.5),
                              '--note-fg': readableTextColor(lightenColor(color, 0.5)),
                              '--note-indicator': EIGEN_STICKIES_INDICATOR_MAP.get(color) ?? color,
                              '--note-soft': 'color-mix(in oklab, var(--note-indicator) 14%, var(--background))',
                          }
                        : undefined
                }
            >
                <h2 className="text-lg leading-snug font-medium break-words">{title}</h2>
                {description && (
                    <div
                        ref={descriptionRef}
                        className="eigen-prose mt-2 text-sm"
                        onClick={handleDescriptionClick}
                        dangerouslySetInnerHTML={{ __html: description }}
                    />
                )}
            </div>
            {attachments}
            {/* min-h-8 keeps the line as tall with "Unassigned" as with an avatar chip, so assigning never shifts it. */}
            {meta && <div className="flex min-h-8 items-center text-xs text-muted-foreground">{meta}</div>}
        </div>
    );
}
