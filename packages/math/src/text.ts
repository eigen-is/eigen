import { toAlphanumeric } from './notation';
import type { MathNode, MathRow } from './tree';

// Word's linear form, a small UnicodeMath subset on one line, for search, word count and text/plain. Nothing reads
// it back.

const COMBINING_LINES = { over: '\u0305', under: '\u0332' } as const;
// UnicodeMath's above and below operators.
const STACKS = { over: '┬', under: '┴' } as const;
const ROOTS: ReadonlyMap<string, string> = new Map([
    ['3', '∛'],
    ['4', '∜'],
]);

// An argument of more than one node is parenthesised: (a+b)/2, x^(n+1).
function argument(row: MathRow): string {
    const text = writeText(row);
    return row.length > 1 ? `(${text})` : text;
}

function scripts(node: { sub?: MathRow; sup?: MathRow }): string {
    return `${node.sub ? `_${argument(node.sub)}` : ''}${node.sup ? `^${argument(node.sup)}` : ''}`;
}

function nodeText(node: MathNode): string {
    switch (node.kind) {
        case 'identifier':
        case 'number':
        case 'operator': {
            const { variant } = node;
            if (!variant) return node.text;
            return [...node.text].map((char) => toAlphanumeric(char, variant) ?? char).join('');
        }
        case 'text':
            return node.text;
        case 'space':
            return ' ';
        case 'fraction':
            return `${argument(node.numerator)}/${argument(node.denominator)}`;
        case 'scripts':
            return node.pre ? `${scripts(node)} ${argument(node.base)}` : `${argument(node.base)}${scripts(node)}`;
        case 'radical': {
            if (!node.degree) return `√${argument(node.body)}`;
            const degree = writeText(node.degree);
            const root = ROOTS.get(degree);
            return root ? `${root}${argument(node.body)}` : `√(${degree}&${writeText(node.body)})`;
        }
        case 'nary': {
            const body = writeText(node.body);
            return `${node.operator}${scripts(node)}${body && ` ${body}`}`;
        }
        case 'fenced':
            return `${node.open}${node.parts.map(writeText).join(node.separator)}${node.close}`;
        case 'function': {
            const [body] = node.body;
            const space = node.body.length === 1 && body.kind === 'fenced' ? '' : ' ';
            return `${writeText(node.name)}${space}${writeText(node.body)}`;
        }
        case 'accent':
            return `${argument(node.body)}${node.accent}`;
        case 'line':
            return `${argument(node.body)}${COMBINING_LINES[node.position]}`;
        case 'brace':
            return `${argument(node.body)}${STACKS[node.position]}${node.char}`;
        case 'limit':
            return `${argument(node.base)}${STACKS[node.position]}${argument(node.limit)}`;
        case 'enclose':
            return `▭(${writeText(node.body)})`;
        case 'table': {
            const rows = node.rows.map((cells) => cells.map(writeText).join('&')).join('@');
            return `${node.layout === 'matrix' ? '■' : '█'}(${rows})`;
        }
    }
}

export function writeText(row: MathRow): string {
    return row.map(nodeText).join('');
}
