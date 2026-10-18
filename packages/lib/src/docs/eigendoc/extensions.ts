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
import { SmallMark } from './nodes/small-mark';
import { SubtitleNode, TitleNode } from './nodes/title';

// The textblocks that hold prose, which an alignment applies to; a code block holds code.
export const PROSE_TEXTBLOCKS = ['paragraph', 'title', 'subtitle', 'heading'];

export function getDocExtensions(options?: { lowlight?: unknown; exclude?: string[] }) {
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
        EigenFontSize,
        TextCaps,
        TaskList,
        TaskItem.configure({ nested: true }),
        TitleNode,
        SubtitleNode,
        TextAlign.configure({ types: PROSE_TEXTBLOCKS }),
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
