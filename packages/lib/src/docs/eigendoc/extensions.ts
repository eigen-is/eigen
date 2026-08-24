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
import { CommentMarkSchema } from './nodes/comment-mark';
import { FigureNode } from './nodes/figure';
import { EigenFontFamily } from './nodes/font-family';
import { SmallMark } from './nodes/small-mark';

export function getDocExtensions(options?: { lowlight?: unknown; exclude?: string[] }) {
    const exclude = options?.exclude;
    const extensions = [
        StarterKit.configure({
            undoRedo: false,
            codeBlock: false,
            link: {
                HTMLAttributes: {
                    target: '_blank',
                    rel: 'noopener noreferrer',
                },
            },
        }),
        Subscript,
        Superscript,
        SmallMark,
        Typography,
        TextStyle,
        Color,
        EigenFontFamily,
        TaskList,
        TaskItem.configure({ nested: true }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        FigureNode,
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
