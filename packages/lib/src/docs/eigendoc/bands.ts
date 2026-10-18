import type { Node } from '@tiptap/pm/model';
import { readEquation } from './nodes/equation';

// The doc's header and footer, each a root XmlFragment beside `default`, edited by an editor of its own. The first
// two print on every page, the last two on page 1 when the page map's differentFirstPage is set.
export const BAND_ROOTS = ['header', 'footer', 'headerFirst', 'footerFirst'] as const;
export type BandRoot = (typeof BAND_ROOTS)[number];

// The band page 1 takes instead of the other pages' one, when differentFirstPage is set.
export const FIRST_PAGE_BAND = { header: 'headerFirst', footer: 'footerFirst' } as const;
export type BandEdge = keyof typeof FIRST_PAGE_BAND;

export const bandEdge = (root: BandRoot): BandEdge =>
    root === 'footer' || root === FIRST_PAGE_BAND.footer ? 'footer' : 'header';

// Nodes a band's schema leaves out, so the Yjs binding deletes one a peer writes: none has a meaning in a header that
// prints on every page, and the chart panel edits the body's charts only. A footnote joins them when the node exists.
// Marks stay: a mark the schema lacks deletes the text that carries it.
export const BAND_EXCLUDED_NODES = ['pageBreak', 'title', 'subtitle', 'codeBlock', 'chart'] as const;

// A band prints, and the page draws it, only with something to show: focusing an empty band leaves an empty paragraph,
// and a line break or an empty equation alone shows nothing either.
export function bandHasContent(doc: Node): boolean {
    let found = false;
    doc.descendants((node) => {
        if (found) return false;
        if (node.isText) found = /\S/.test(node.text ?? '');
        else if (node.type.name === 'equation') found = readEquation(node.attrs).row.length > 0;
        else found = node.isLeaf && node.type.name !== 'hardBreak';
        return !found;
    });
    return found;
}
