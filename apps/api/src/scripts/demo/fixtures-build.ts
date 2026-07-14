// Builds the slides deck and stickies board Y.Doc structures for the committed fixture
// containers. Kept separate from the authoring script so the exact Yjs shapes (which the
// shipped editors and readers depend on) live in one place. The frontend readers require
// `objectIds`/`slideOrder`/`taskIds`/`columnOrder` to be real Y.Array instances, while
// `background`/`commentCardIds` stay plain JS values — mixing those up mis-renders.
import * as Y from 'yjs';
import type { CardSpec, SlideSpec } from './content';

// Fixed design canvas (packages/lib/src/slides/types.ts): 1920x1080, origin top-left.
const SLIDE_W = 1920;

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A text object carries the full DEFAULT_TEXT_OBJECT field set (apps/slides types.ts) plus
// id/slideId; commentCardIds is a plain array, not a Y type.
function textObject(
    id: string,
    slideId: string,
    html: string,
    over: { x: number; y: number; w: number; h: number; fontSize: number; fontWeight?: string; color?: string },
): Y.Map<unknown> {
    const obj = new Y.Map<unknown>();
    obj.set('id', id);
    obj.set('slideId', slideId);
    obj.set('type', 'text');
    obj.set('x', over.x);
    obj.set('y', over.y);
    obj.set('w', over.w);
    obj.set('h', over.h);
    obj.set('rotation', 0);
    obj.set('text', html);
    obj.set('fontFamily', 'Inter');
    obj.set('fontSize', over.fontSize);
    obj.set('fontWeight', over.fontWeight ?? 'normal');
    obj.set('fontStyle', 'normal');
    obj.set('textDecoration', 'none');
    obj.set('textAlign', 'center');
    obj.set('verticalAlign', 'center');
    obj.set('color', over.color ?? '#000000');
    obj.set('letterSpacing', 0);
    obj.set('lineHeight', 1.2);
    obj.set('highlightColor', '');
    obj.set('background', null);
    obj.set('borderColor', '');
    obj.set('borderWidth', 0);
    obj.set('borderRadius', 0);
    obj.set('commentCardIds', []);
    return obj;
}

export function buildSlidesDoc(doc: Y.Doc, slides: SlideSpec[]): void {
    const slidesMap = doc.getMap('slides');
    const objectsMap = doc.getMap('objects');
    const slideOrder = doc.getArray<string>('slideOrder');
    doc.transact(() => {
        slides.forEach((spec, i) => {
            const slideId = `slide-${i + 1}`;
            const headingId = `obj-${i + 1}-h`;
            const bodyId = `obj-${i + 1}-b`;

            const slide = new Y.Map<unknown>();
            slide.set('id', slideId);
            slide.set('background', { type: 'solid', color: '#ffffff' });
            const objectIds = new Y.Array<string>();
            objectIds.push([headingId, bodyId]);
            slide.set('objectIds', objectIds);
            slidesMap.set(slideId, slide);

            const margin = 192;
            const width = SLIDE_W - margin * 2;
            objectsMap.set(
                headingId,
                textObject(headingId, slideId, `<p>${escapeHtml(spec.heading)}</p>`, {
                    x: margin,
                    y: 340,
                    w: width,
                    h: 200,
                    fontSize: 72,
                    fontWeight: 'bold',
                    color: '#111111',
                }),
            );
            objectsMap.set(
                bodyId,
                textObject(bodyId, slideId, `<p>${escapeHtml(spec.body)}</p>`, {
                    x: margin,
                    y: 560,
                    w: width,
                    h: 180,
                    fontSize: 40,
                    color: '#444444',
                }),
            );
            slideOrder.push([slideId]);
        });
    });
}

// Cards embed `creator` as a bare persona key here; the seeder domainises it to an email after
// placing the fixture, so the board resolves author names regardless of the deployment's mail
// domain. `boardAuthor` is the persona key that owns the columns.
export function buildStickiesDoc(doc: Y.Doc, columns: string[], cards: CardSpec[], boardAuthor: string): void {
    const columnsMap = doc.getMap('columns');
    const tasksMap = doc.getMap('tasks');
    const columnOrder = doc.getArray<string>('columnOrder');
    doc.transact(() => {
        const now = Date.now();
        const colIdByTitle = new Map<string, string>();
        columns.forEach((title, i) => {
            const colId = `col-${i + 1}`;
            colIdByTitle.set(title, colId);
            const col = new Y.Map<unknown>();
            col.set('id', colId);
            col.set('title', title);
            col.set('taskIds', new Y.Array<string>());
            col.set('creator', boardAuthor);
            col.set('createdAt', now);
            columnsMap.set(colId, col);
            columnOrder.push([colId]);
        });
        cards.forEach((card, i) => {
            const cardId = `card-${i + 1}`;
            const colId = colIdByTitle.get(card.column);
            if (!colId) throw new Error(`Card "${card.title}" references unknown column "${card.column}"`);
            const task = new Y.Map<unknown>();
            task.set('id', cardId);
            task.set('title', card.title);
            task.set('description', card.description);
            task.set('creator', card.creator);
            task.set('createdAt', now);
            tasksMap.set(cardId, task);
            const taskIds = (columnsMap.get(colId) as Y.Map<unknown>).get('taskIds') as Y.Array<string>;
            taskIds.push([cardId]);
        });
    });
}
