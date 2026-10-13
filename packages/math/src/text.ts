import { toAlphanumeric } from './notation';
import type { MathNode, MathRow } from './tree';
import { checkedXml } from './xml';

// Word's linear form, a small UnicodeMath subset on one line, for search, word count and text/plain. Nothing reads
// it back.

const COMBINING_LINES = { over: '\u0305', under: '\u0332' } as const;
// UnicodeMath's above and below operators.
const STACKS = { over: '┬', under: '┴' } as const;
const ROOTS: ReadonlyMap<string, string> = new Map([
    ['3', '∛'],
    ['4', '∜'],
]);

// An operand UnicodeMath would split is parenthesised: more than one node, (a+b)/2, or one that has operands of its
// own, (a/b)^2.
const COMPOUND: ReadonlySet<MathNode['kind']> = new Set(['fraction', 'scripts', 'nary', 'function']);

function argument(row: MathRow): string {
    const text = rowText(row);
    return row.length > 1 || (row.length === 1 && COMPOUND.has(row[0].kind)) ? `(${text})` : text;
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
            const degree = rowText(node.degree);
            const root = ROOTS.get(degree);
            return root ? `${root}${argument(node.body)}` : `√(${degree}&${rowText(node.body)})`;
        }
        case 'nary': {
            const body = rowText(node.body);
            return `${node.operator}${scripts(node)}${body && ` ${body}`}`;
        }
        case 'fenced':
            return `${node.open}${node.parts.map(rowText).join(node.separator)}${node.close}`;
        case 'function': {
            const [body] = node.body;
            const space = node.body.length === 1 && body.kind === 'fenced' ? '' : ' ';
            return `${rowText(node.name)}${space}${rowText(node.body)}`;
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
            return `▭(${rowText(node.body)})`;
        case 'table': {
            const rows = node.rows.map((cells) => cells.map(rowText).join('&')).join('@');
            return `${node.layout === 'matrix' ? '■' : '█'}(${rows})`;
        }
    }
}

// UnicodeMath ends an operand at a space or an operator and drops the space, so a space keeps a compound node from
// running into the next: x^2 4, never x^24.
function rowText(row: MathRow): string {
    return row
        .map((node, index) => {
            const next = row[index + 1];
            const runsOn = next && COMPOUND.has(node.kind) && next.kind !== 'operator' && next.kind !== 'space';
            return runsOn ? `${nodeText(node)} ` : nodeText(node);
        })
        .join('');
}

// As every writer, it refuses a character XML can't hold rather than pass it on.
export function writeText(row: MathRow): string {
    return checkedXml(rowText(row));
}
