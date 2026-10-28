// The Docs schema: every node, mark and extension a doc holds. The editor builds it with its own options, and the server
// builds it headless to parse, render and export a stored doc. So a node one side writes is one the other can read.

import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Highlight from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table, TableRow } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import Typography from '@tiptap/extension-typography';
import type { Transaction } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { TextCaps } from './nodes/caps';
import { ChartNode } from './nodes/chart';
import { CommentMarkSchema } from './nodes/comment-mark';
import { EquationNode } from './nodes/equation';
import { FigureNode } from './nodes/figure';
import { EigenFontFamily } from './nodes/font-family';
import { EigenFontSize } from './nodes/font-size';
import { FootnoteNode } from './nodes/footnote';
import { EigenLink } from './nodes/link';
import { EigenOrderedList } from './nodes/ordered-list';
import { PageBreakNode } from './nodes/page-break';
import { PageNumberNode } from './nodes/page-number';
import { EigenParagraphFormat } from './nodes/paragraph-format';
import { SmallMark } from './nodes/small-mark';
import { EigenTableCell, EigenTableHeader } from './nodes/table-cell';
import { TableOfContentsNode } from './nodes/table-of-contents';
import { SubtitleNode, TitleNode } from './nodes/title';
import type { NormalStyle } from './normal-style';
import { PROSE_TEXTBLOCKS } from './paragraph-format';

// textColumnWidth: the editor's text column in px, which a paragraph's indent stays within. normalStyle: the doc's
// Normal, which unsized text draws at. remote: a transaction the editor's Yjs binding applied, which autolinks nothing.
export function getDocExtensions(options?: {
    lowlight?: unknown;
    exclude?: string[];
    textColumnWidth?: () => number;
    normalStyle?: () => NormalStyle;
    remote?: (tr: Transaction) => boolean;
}) {
    const exclude = options?.exclude;
    const extensions = [
        StarterKit.configure({
            undoRedo: false,
            codeBlock: false,
            orderedList: false,
            link: false,
        }),
        EigenLink.configure({
            ...(options?.remote && { remote: options.remote }),
            autolink: false,
            HTMLAttributes: {
                target: '_blank',
                rel: 'noopener noreferrer',
            },
        }),
        EigenOrderedList,
        Subscript,
        Superscript,
        SmallMark,
        Typography,
        TextStyle,
        Color,
        EigenFontFamily,
        EigenFontSize.configure(options?.normalStyle && { normalStyle: options.normalStyle }),
        TextCaps,
        TaskList,
        TaskItem.configure({ nested: true }),
        TitleNode,
        SubtitleNode,
        TextAlign.configure({ types: PROSE_TEXTBLOCKS }),
        EigenParagraphFormat.configure({
            types: PROSE_TEXTBLOCKS,
            ...(options?.textColumnWidth && { textColumnWidth: options.textColumnWidth }),
        }),
        FigureNode,
        ChartNode,
        EquationNode,
        PageBreakNode,
        PageNumberNode,
        TableOfContentsNode,
        FootnoteNode,
        // ⇧⌘H is Find and replace, as in Google Docs, which binds no key to highlighting.
        Highlight.extend({ addKeyboardShortcuts: () => ({}) }).configure({ multicolor: true }),
        ...(options?.lowlight ? [CodeBlockLowlight.configure({ lowlight: options.lowlight })] : []),
        Table,
        TableRow,
        EigenTableCell,
        EigenTableHeader,
        CommentMarkSchema,
    ];
    return exclude ? extensions.filter((ext) => !exclude.includes(ext.name)) : extensions;
}
