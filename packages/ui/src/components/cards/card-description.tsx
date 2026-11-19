// A card's description in its dialog. It reads as text, where a writer ticks a task list's boxes without editing, and
// its pencil opens the light editor in its place, as a chat message's does. Clicking away or Mod+Enter saves; the
// cancel button in the pencil's place, Esc and the dialog's close button cancel. Ticking the last box of a list now and
// then celebrates.

import { countTaskItems } from '@workspace/lib/html';
import { Pencil, X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useEffect, useRef } from 'react';
import { cn } from '../../lib/utils';
import { useCelebrate } from '../celebrate/use-celebrate';
import { LightEditor } from '../editor/light-editor';
import { HoverActionBar } from '../layout/toolbar/hover-action-bar';
import { TooltipButton } from '../layout/toolbar/tooltip-button';

const PLACEHOLDER = 'Add a description…';
// A card has no long press that offers Edit, so a touch screen shows its action bar at all times.
export const SHOW_ON_TOUCH = 'pointer-coarse:pointer-events-auto pointer-coarse:opacity-100';

type CardDescriptionProps = {
    description: string;
    canWrite: boolean;
    editing: boolean;
    onEdit: () => void;
    onCancel: () => void;
    // Gets the html only when it differs from what the editor first drew, so an unchanged edit writes nothing.
    onSave: (html: string | null) => void;
    // A tick in the read view, saved at once.
    onTick: (html: string) => void;
};

export function CardDescription({
    description,
    canWrite,
    editing,
    onEdit,
    onCancel,
    onSave,
    onTick,
}: CardDescriptionProps) {
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

    if (editing) return <DescriptionEditor initial={description} onSave={onSave} onCancel={onCancel} />;

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target;
        if (!canWrite || !(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
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
            celebrateBoxRef.current = [...e.currentTarget.querySelectorAll('input[type="checkbox"]')].indexOf(target);
        }
        onTick(html);
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
        <div className="group relative -mx-2 rounded-md px-2 py-1 transition-colors pointer-fine:hover:bg-muted/50">
            {description ? (
                <div
                    ref={descriptionRef}
                    className="eigen-prose text-sm"
                    onClick={handleClick}
                    dangerouslySetInnerHTML={{ __html: description }}
                />
            ) : (
                <button
                    type="button"
                    className="w-full cursor-text py-1 text-left text-sm text-muted-foreground"
                    onClick={onEdit}
                >
                    {PLACEHOLDER}
                </button>
            )}
            {description && (
                <HoverActionBar className={cn('right-1', SHOW_ON_TOUCH)}>
                    <TooltipButton icon={Pencil} tooltipText="Edit description" className="h-7 w-7" onClick={onEdit} />
                </HoverActionBar>
            )}
        </div>
    );
}

function DescriptionEditor({
    initial,
    onSave,
    onCancel,
}: {
    initial: string;
    onSave: (html: string | null) => void;
    onCancel: () => void;
}) {
    // TipTap redraws an old plain-text description in its own html, so the first parse is the baseline a save
    // compares against, not the stored string.
    const baseline = useRef(initial);
    const html = useRef(initial);
    const save = () => onSave(html.current === baseline.current ? null : html.current);

    return (
        <CardDescriptionEditor
            content={initial}
            onChange={(next) => {
                html.current = next;
            }}
            onReady={({ editor, html: first }) => {
                baseline.current = first;
                html.current = first;
                editor.commands.focus('end');
            }}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) save();
            }}
            onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    save();
                }
            }}
            onCancel={onCancel}
        />
    );
}

type CardDescriptionEditorProps = Pick<ComponentProps<typeof LightEditor>, 'content' | 'onChange' | 'onReady'> &
    Omit<ComponentProps<'div'>, 'onChange' | 'className'> & {
        editorClassName?: string;
        // An open card's edit puts its cancel button where the pencil was.
        onCancel?: () => void;
    };

// The light editor in the description's frame, as both card dialogs draw it: open here, and from the start in the
// dialog that adds a card.
export function CardDescriptionEditor({
    content,
    onChange,
    onReady,
    editorClassName = 'min-h-[120px]',
    onCancel,
    ...frame
}: CardDescriptionEditorProps) {
    return (
        <div
            className={cn(
                'relative -mx-2 rounded-md border border-input px-2 py-1 text-sm focus-within:ring-[3px] focus-within:ring-ring/50',
                onCancel && 'pr-9',
            )}
            {...frame}
        >
            {onCancel && (
                // It keeps the focus in the editor, or the editor would lose it, and save, before the cancel.
                <TooltipButton
                    icon={X}
                    tooltipText="Cancel"
                    preventFocusLoss
                    className="absolute top-0.5 right-0.5 h-7 w-7"
                    onClick={onCancel}
                />
            )}
            <LightEditor
                content={content}
                onChange={onChange}
                onReady={onReady}
                taskList
                submitOnModEnter
                placeholder={PLACEHOLDER}
                containerClassName="relative flex flex-col"
                className={editorClassName}
            />
        </div>
    );
}
