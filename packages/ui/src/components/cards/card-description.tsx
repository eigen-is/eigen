// A card's description in its dialog. It reads as text, where a writer ticks a task list's boxes without editing, and
// a click anywhere else opens the light editor in its place. Clicking away or Mod+Enter saves; the dialog cancels it on
// Esc or its close button. Ticking the last box of a list now and then celebrates.

import { countTaskItems } from '@workspace/lib/html';
import { Pencil } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cn, SOFT_HOVER_REVEAL_CLASS } from '../../lib/utils';
import { useCelebrate } from '../celebrate/use-celebrate';
import { LightEditor } from '../editor/light-editor';

export const DESCRIPTION_PLACEHOLDER = 'Add a description…';
// The editor's frame, here and in the dialog that adds a card.
export const DESCRIPTION_EDITOR_CLASS =
    '-mx-2 rounded-md border border-input px-2 py-1 text-sm focus-within:ring-[3px] focus-within:ring-ring/50';

type CardDescriptionProps = {
    description: string;
    canWrite: boolean;
    editing: boolean;
    onEdit: () => void;
    // Gets the html only when it differs from what the editor first drew, so an unchanged edit writes nothing.
    onSave: (html: string | null) => void;
    // A tick in the read view, saved at once.
    onTick: (html: string) => void;
};

export function CardDescription({ description, canWrite, editing, onEdit, onSave, onTick }: CardDescriptionProps) {
    const celebrate = useCelebrate();
    // One try per opening: the chance is rolled once, so unticking and re-ticking the last box can't farm it.
    const celebratedRef = useRef(false);
    // The parent draws the saved description again, which replaces every box in the page. So the celebration waits
    // for that and starts from the box at the same place in the list, as the clicked one is gone by then.
    const descriptionRef = useRef<HTMLDivElement>(null);
    const celebrateBoxRef = useRef<number | null>(null);
    useEffect(() => {
        const index = celebrateBoxRef.current;
        if (index === null) return;
        celebrateBoxRef.current = null;
        const box = descriptionRef.current?.querySelectorAll('input[type="checkbox"]')[index];
        if (box instanceof HTMLElement) celebrate(box);
    }, [description]);

    if (editing) return <DescriptionEditor initial={description} onSave={onSave} />;

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!canWrite) return;
        const target = e.target;
        if (target instanceof HTMLInputElement && target.type === 'checkbox') {
            const li = target.closest('li[data-checked]');
            if (!li) return;
            li.setAttribute('data-checked', target.checked ? 'true' : 'false');
            if (target.checked) target.setAttribute('checked', '');
            else target.removeAttribute('checked');
            const html = e.currentTarget.innerHTML;
            const { checked, total } = countTaskItems(html);
            // A checklist of one item is a toggle, not a list.
            if (total >= 2 && checked === total && !celebratedRef.current) {
                celebratedRef.current = true;
                celebrateBoxRef.current = [...e.currentTarget.querySelectorAll('input[type="checkbox"]')].indexOf(
                    target,
                );
            }
            onTick(html);
            return;
        }
        // A link opens, and a drag that selected text is a copy, not an edit.
        if (target instanceof Element && target.closest('a')) return;
        if (!window.getSelection()?.isCollapsed) return;
        onEdit();
    };

    if (!canWrite) {
        return (
            <div
                ref={descriptionRef}
                className="eigen-prose text-sm"
                dangerouslySetInnerHTML={{ __html: description }}
            />
        );
    }

    return (
        <div className="group relative -mx-2 rounded-md px-2 py-1 pointer-fine:hover:bg-muted/60">
            {description ? (
                <div
                    ref={descriptionRef}
                    className="eigen-prose cursor-text text-sm"
                    onClick={handleClick}
                    dangerouslySetInnerHTML={{ __html: description }}
                />
            ) : (
                <button
                    type="button"
                    className="w-full cursor-text py-1 text-left text-sm text-muted-foreground"
                    onClick={onEdit}
                >
                    {DESCRIPTION_PLACEHOLDER}
                </button>
            )}
            {description && (
                <button
                    type="button"
                    aria-label="Edit description"
                    className={cn(
                        'absolute top-1 right-1 rounded-sm p-1 text-muted-foreground',
                        SOFT_HOVER_REVEAL_CLASS,
                    )}
                    onClick={onEdit}
                >
                    <Pencil className="h-3.5 w-3.5" />
                </button>
            )}
        </div>
    );
}

function DescriptionEditor({ initial, onSave }: { initial: string; onSave: (html: string | null) => void }) {
    // TipTap redraws an old plain-text description in its own html, so the first parse is the baseline a save
    // compares against, not the stored string.
    const baseline = useRef(initial);
    const html = useRef(initial);
    const save = () => onSave(html.current === baseline.current ? null : html.current);

    return (
        <div
            className={DESCRIPTION_EDITOR_CLASS}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) save();
            }}
            onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    save();
                }
            }}
        >
            <LightEditor
                content={initial}
                onChange={(next) => {
                    html.current = next;
                }}
                onReady={({ editor, html: first }) => {
                    baseline.current = first;
                    html.current = first;
                    editor.commands.focus('end');
                }}
                taskList
                submitOnModEnter
                placeholder={DESCRIPTION_PLACEHOLDER}
                containerClassName="relative flex flex-col"
                className="min-h-[120px]"
            />
        </div>
    );
}
