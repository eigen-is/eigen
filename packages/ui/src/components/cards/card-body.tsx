// A card as it reads when opened: its title and description on its block in the card's color, a meta line, such as
// who created it, then its attachments. A reader with write access can tick the boxes of a task list in the description
// without opening the editor, and ticking the last box of a list now and then celebrates. It is the lead of the
// card's thread, so it scrolls with the replies in any host, such as the card dialog. A host may make the block a way
// back to where the card sits, such as the comments column's jump to a comment's anchor.

import { countTaskItems } from '@workspace/lib/html';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { useCelebrate } from '../celebrate/use-celebrate';
import { DetailItemBlock, DetailMeta, DetailSection } from '../layout/app/detail-item';

type CardBodyProps = {
    title: string;
    description?: string;
    color?: string | null;
    canWrite?: boolean;
    // Fires after a task-list checkbox toggle inside `description`, with the toggled HTML.
    onDescriptionChange?: (html: string) => void;
    attachments?: ReactNode;
    meta?: ReactNode;
    // A click on the block, away from a box or a link in the description, such as a comment's jump to its anchor.
    onBlockClick?: () => void;
};

export function CardBody({
    title,
    description,
    color,
    canWrite,
    onDescriptionChange,
    attachments,
    meta,
    onBlockClick,
}: CardBodyProps) {
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
        <div className="app-gutter-x pt-1 pb-4">
            <DetailItemBlock
                title={title}
                color={color}
                onClick={
                    onBlockClick &&
                    ((e) => {
                        if (!(e.target instanceof Element && e.target.closest('a, input'))) onBlockClick();
                    })
                }
            >
                {description && (
                    <div
                        ref={descriptionRef}
                        className="eigen-prose"
                        onClick={handleDescriptionClick}
                        dangerouslySetInnerHTML={{ __html: description }}
                    />
                )}
            </DetailItemBlock>
            {meta && <DetailMeta>{meta}</DetailMeta>}
            {attachments && <DetailSection label="Attachments">{attachments}</DetailSection>}
        </div>
    );
}
