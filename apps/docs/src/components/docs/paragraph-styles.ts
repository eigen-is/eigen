import type { Node, Schema } from '@tiptap/pm/model';
import type { TitleType } from '@workspace/lib/docs/eigendoc';
import {
    Heading,
    Heading1,
    Heading2,
    Heading3,
    Heading4,
    Heading5,
    Heading6,
    LetterText,
    type LucideIcon,
} from 'lucide-react';

type ParagraphStyle = {
    name: string;
    type: TitleType | 'heading';
    attrs?: { level: number };
    icon: LucideIcon;
    preview: string;
};

// Format › Paragraph styles and the style picker list these after Normal text, in Google Docs' order. The picker
// previews each as the editor draws it: the title largest, the subtitle in grey, the heading sizes stepping down, and
// Heading 5 and 6 at the body's weight in grey, Heading 6 in italic.
const PARAGRAPH_STYLES: ParagraphStyle[] = [
    { name: 'Title', type: 'title', icon: Heading, preview: 'text-2xl' },
    { name: 'Subtitle', type: 'subtitle', icon: LetterText, preview: 'text-base text-muted-foreground' },
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
];

// The style a textblock is in; Normal text and code are none.
export function paragraphStyleOf(node: Node): ParagraphStyle | undefined {
    return PARAGRAPH_STYLES.find(
        ({ type, attrs }) => type === node.type.name && (!attrs || attrs.level === node.attrs['level']),
    );
}

// The styles an editor's schema holds: a band's has no title or subtitle, and a command for a node it lacks throws.
export function paragraphStylesIn(schema: Schema): ParagraphStyle[] {
    return PARAGRAPH_STYLES.filter(({ type }) => type in schema.nodes);
}
