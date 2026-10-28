// The Docs paragraph styles after Normal text, the headings and Title and Subtitle, with their icons and previews. The
// style picker lists the headings, Format › Paragraph styles all of them, and the toolbar reads which one the selection
// is in.

import type { Node, Schema } from '@tiptap/pm/model';
import type { TitleType } from '@workspace/lib/docs/eigendoc';
import type { LucideIcon } from 'lucide-react';
import { Heading, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, LetterText } from 'lucide-react';

type ParagraphStyle = {
    name: string;
    type: TitleType | 'heading';
    attrs?: { level: number };
    icon: LucideIcon;
    preview: string;
};

// The headings, then Title and Subtitle, which few people pick but Word and Google Docs files hold: the Format menu
// lists them all, and the picker leaves those two out. The picker previews each heading as the editor draws it, the
// sizes stepping down, and Heading 5 and 6 at the body's weight in gray, Heading 6 in italic.
const PARAGRAPH_STYLES: ParagraphStyle[] = [
    { name: 'Heading 1', type: 'heading', attrs: { level: 1 }, icon: Heading1, preview: 'text-xl font-medium' },
    { name: 'Heading 2', type: 'heading', attrs: { level: 2 }, icon: Heading2, preview: 'text-lg font-medium' },
    { name: 'Heading 3', type: 'heading', attrs: { level: 3 }, icon: Heading3, preview: 'text-base font-medium' },
    { name: 'Heading 4', type: 'heading', attrs: { level: 4 }, icon: Heading4, preview: 'text-sm font-medium' },
    {
        name: 'Heading 5',
        type: 'heading',
        attrs: { level: 5 },
        icon: Heading5,
        preview: 'text-sm text-muted-foreground',
    },
    {
        name: 'Heading 6',
        type: 'heading',
        attrs: { level: 6 },
        icon: Heading6,
        preview: 'text-sm text-muted-foreground italic',
    },
    { name: 'Title', type: 'title', icon: Heading, preview: 'text-2xl' },
    { name: 'Subtitle', type: 'subtitle', icon: LetterText, preview: 'text-base text-muted-foreground' },
];

// The style a textblock is in; Normal text and code are none.
export function paragraphStyleOf(node: Node): ParagraphStyle | undefined {
    return PARAGRAPH_STYLES.find(
        ({ type, attrs }) => type === node.type.name && (!attrs || attrs.level === node.attrs['level']),
    );
}

// The styles, or only the headings, that an editor's schema holds: a band's has no title or subtitle, and a command for
// a node it lacks throws.
export function paragraphStylesIn(schema: Schema, group: 'all' | 'headings'): ParagraphStyle[] {
    return PARAGRAPH_STYLES.filter(({ type }) => type in schema.nodes && (group === 'all' || type === 'heading'));
}
