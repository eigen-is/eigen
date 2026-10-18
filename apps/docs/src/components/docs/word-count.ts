import type { Node } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { isFigureFrameNode, readEquation, readFigureFrameAttrs } from '@workspace/lib/docs/eigendoc';

export type TextCounts = { words: number; characters: number; charactersExcludingSpaces: number };

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

// A leaf ends the word before it; a figure or a chart adds its caption, never its alt text, media name or chart text,
// and an equation its text.
function leafText(node: Node): string {
    if (isFigureFrameNode(node.type.name)) return `\n${readFigureFrameAttrs(node.attrs).caption ?? ''}\n`;
    if (node.type.name === 'equation') return `\n${readEquation(node.attrs).text}\n`;
    return '\n\n';
}

function countGraphemes(text: string): number {
    let count = 0;
    for (const _ of graphemes.segment(text)) count++;
    return count;
}

// Words split on whitespace, as Google Docs splits them, and a token without a letter or digit (a dash) is none. A
// character is a grapheme, what a reader sees as one, spaces included and line breaks not.
function countText(text: string): TextCounts {
    return {
        words: text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length,
        characters: countGraphemes(text.replaceAll('\n', '')),
        charactersExcludingSpaces: countGraphemes(text.replace(/\s/g, '')),
    };
}

// The whole doc, and the selection when it holds any range (a table's cells are several). A footnote's note counts
// nothing, as in Google Docs, and its reference ends the word before it.
export function countWords({ doc, selection }: EditorState): { document: TextCounts; selection: TextCounts | null } {
    const textOf = (from: number, to: number) => {
        const runs: string[] = [];
        let start = from;
        doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name !== 'footnote') return true;
            runs.push(doc.textBetween(start, Math.max(start, pos), '\n', leafText));
            start = Math.max(start, pos + node.nodeSize);
            return false;
        });
        runs.push(doc.textBetween(start, Math.max(start, to), '\n', leafText));
        return runs.join('\n');
    };
    return {
        document: countText(textOf(0, doc.content.size)),
        selection: selection.empty
            ? null
            : countText(selection.ranges.map(({ $from, $to }) => textOf($from.pos, $to.pos)).join('\n')),
    };
}
