import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Highlight from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import Typography from '@tiptap/extension-typography';
import StarterKit from '@tiptap/starter-kit';
import { TextCaps } from './nodes/caps';
import { ChartNode } from './nodes/chart';
import { CommentMarkSchema } from './nodes/comment-mark';
import { EquationNode } from './nodes/equation';
import { FigureNode } from './nodes/figure';
import { EigenFontFamily } from './nodes/font-family';
import { EigenFontSize } from './nodes/font-size';
import { EigenOrderedList } from './nodes/ordered-list';
import { PageBreakNode } from './nodes/page-break';
import { PageNumberNode } from './nodes/page-number';
import { EigenParagraphFormat, PROSE_TEXTBLOCKS } from './nodes/paragraph-format';
import { SmallMark } from './nodes/small-mark';
import { SubtitleNode, TitleNode } from './nodes/title';
import type { NormalStyle } from './normal-style';

// textColumnWidth: the editor's text column in px, which a paragraph's indent stays within. normalStyle: the doc's
// Normal, which unsized text draws at.
export function getDocExtensions(options?: {
    lowlight?: unknown;
    exclude?: string[];
    textColumnWidth?: () => number;
    normalStyle?: () => NormalStyle;
}) {
    const exclude = options?.exclude;
    const extensions = [
        StarterKit.configure({
            undoRedo: false,
            codeBlock: false,
            orderedList: false,
            link: {
                HTMLAttributes: {
                    target: '_blank',
                    rel: 'noopener noreferrer',
                },
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
        Highlight.configure({ multicolor: true }),
        ...(options?.lowlight ? [CodeBlockLowlight.configure({ lowlight: options.lowlight })] : []),
        Table,
        TableRow,
        TableCell,
        TableHeader,
        CommentMarkSchema,
    ];
    return exclude ? extensions.filter((ext) => !exclude.includes(ext.name)) : extensions;
}
