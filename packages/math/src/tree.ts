import { MathError } from './error';
import { fromAlphanumeric, SPACES } from './notation';
import { checkedXml, replaceEdges, trimXmlSpace } from './xml';

export const MATH_VARIANTS = [
    'normal',
    'bold',
    'italic',
    'bold-italic',
    'double-struck',
    'bold-fraktur',
    'script',
    'bold-script',
    'fraktur',
    'sans-serif',
    'bold-sans-serif',
    'sans-serif-italic',
    'sans-serif-bold-italic',
    'monospace',
] as const;

export type MathVariant = (typeof MATH_VARIANTS)[number];

export const MATH_SPACES = ['normal', 'thin', 'medium', 'thick', 'quad', 'qquad'] as const;

export type MathSpace = (typeof MATH_SPACES)[number];

// In the order a canonical enclose lists them.
export const MATH_ENCLOSURES = [
    'top',
    'bottom',
    'left',
    'right',
    'horizontalstrike',
    'verticalstrike',
    'updiagonalstrike',
    'downdiagonalstrike',
] as const;

export type MathEnclosure = (typeof MATH_ENCLOSURES)[number];

export type MathRow = MathNode[];

export type MathNode =
    | { kind: 'identifier' | 'number' | 'operator'; text: string; variant?: MathVariant; color?: string }
    | { kind: 'text'; text: string; color?: string }
    | { kind: 'space'; width: MathSpace }
    | { kind: 'fraction'; numerator: MathRow; denominator: MathRow; line: 'bar' | 'none' | 'skewed' }
    | { kind: 'scripts'; base: MathRow; sub?: MathRow; sup?: MathRow; pre?: true }
    | { kind: 'radical'; body: MathRow; degree?: MathRow }
    | { kind: 'nary'; operator: string; limits: 'under' | 'side'; sub?: MathRow; sup?: MathRow; body: MathRow }
    | { kind: 'fenced'; open: string; close: string; separator: string; parts: MathRow[] }
    | { kind: 'function'; name: MathRow; body: MathRow }
    | { kind: 'accent'; accent: string; body: MathRow }
    | { kind: 'line'; position: 'over' | 'under'; body: MathRow }
    | { kind: 'brace'; char: string; position: 'over' | 'under'; body: MathRow }
    | { kind: 'limit'; position: 'over' | 'under'; base: MathRow; limit: MathRow }
    | { kind: 'enclose'; notation: MathEnclosure[]; body: MathRow }
    | { kind: 'table'; layout: 'matrix' | 'equations'; rows: MathRow[][] };

export type MathToken = Extract<MathNode, { kind: 'identifier' | 'number' | 'operator' }>;

export type MathBudget = { size: number };

// The corpus's 177 equations nest at most 7 deep and reach size 316: about 4× and 30× headroom.
const SIZE = 10_000;

export const MATH_LIMITS = {
    // Levels a reader walks: a node's row, or an element it reads through.
    depth: 32,
    // Every node, row, table row and character of text counts one.
    size: SIZE,
    // The largest admitted tree's MathML: a unit writes at most 64 characters (an menclose drawing every line),
    // plus the root.
    mathmlLength: 64 * SIZE + 256,
} as const;

// Every reader calls this as it builds: at each level it walks, and for each node, row and character it makes.
export function bound(budget: MathBudget, depth: number, size: number): void {
    budget.size += size;
    if (depth > MATH_LIMITS.depth) throw new MathError(`An equation nests at most ${MATH_LIMITS.depth} levels deep`);
    if (budget.size > MATH_LIMITS.size) throw new MathError(`An equation holds at most ${MATH_LIMITS.size} parts`);
}

const INVISIBLE = /^[\u200B\u2061-\u2064]$/u;
const LETTER = /^\p{L}$/u;
const DIGIT = /^[0-9]$/;
const SPACE_OF_CHAR = new Map<string, MathSpace>([
    [SPACES.normal.text, 'normal'],
    [SPACES.thin.text, 'thin'],
    [SPACES.medium.text, 'medium'],
    [SPACES.thick.text, 'thick'],
    [SPACES.quad.text, 'quad'],
    // The no-break space belongs to text; between math characters, as XML's whitespace, it is a plain space.
    ['\u00A0', 'normal'],
    ['\t', 'normal'],
    ['\n', 'normal'],
    ['\r', 'normal'],
]);

// The one character a fence, accent, brace or large operator holds; '' for none.
export function mark(text: string): string {
    const [char = ''] = checkedXml(trimXmlSpace(text));
    return INVISIBLE.test(char) ? '' : char;
}

export function toColor(hex: string | undefined): string | undefined {
    return hex && /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex.toUpperCase()}` : undefined;
}

function token(kind: MathToken['kind'], text: string, variant: MathVariant | undefined, color: string | undefined) {
    const node: MathToken = { kind, text };
    if (variant) node.variant = variant;
    if (color) node.color = color;
    return node;
}

// A text node's text: a tab or line break is a space, as MathML would trim it at an edge.
export const mathText = (raw: string) => checkedXml(raw).replace(/[\t\n\r]/g, ' ');

export const optional = (row: MathRow) => (row.length > 0 ? row : undefined);

// Word marks alignment points with & in an equation: they split it into cells.
export function equationCells(row: MathRow): MathRow[] {
    const cells: MathRow[] = [[]];
    for (const node of row) {
        if (node.kind === 'operator' && node.text === '&') cells.push([]);
        else cells[cells.length - 1].push(node);
    }
    return cells;
}

type StyledChar = { char: string; variant: MathVariant; color: string | undefined };

// The MathML writer keeps a text's edge spaces as no-break spaces; they read back as spaces.
const TEXT_EDGE: ReadonlySet<string> = new Set(' \u00A0');

// One row as a reader builds it. Characters wait until the next node, so tokens come out canonical whatever the
// runs or elements they were spread over: a maximal number, an upright word, one styled letter at a time.
export class RowBuilder {
    readonly #row: MathRow = [];
    #chars: StyledChar[] = [];

    constructor(
        readonly budget: MathBudget,
        readonly depth: number,
    ) {
        bound(budget, depth, 1);
    }

    chars(text: string, letters: MathVariant, others: MathVariant, color: string | undefined): void {
        for (const char of checkedXml(text)) {
            if (INVISIBLE.test(char)) continue;
            const [base, variant] = fromAlphanumeric(char) ?? [char, LETTER.test(char) ? letters : others];
            this.#chars.push({ char: base, variant, color });
        }
    }

    text(raw: string, color: string | undefined): void {
        const text = mathText(raw);
        if (text === '') return;
        this.#flush();
        const last = this.#row.at(-1);
        if (last?.kind === 'text' && last.color === color) {
            bound(this.budget, this.depth, text.length);
            last.text += text;
            return;
        }
        this.#push(color ? { kind: 'text', text, color } : { kind: 'text', text }, text.length);
    }

    node(node: MathNode): void {
        this.#flush();
        this.#push(node, 0);
    }

    done(): MathRow {
        this.#flush();
        for (const node of this.#row) {
            if (node.kind === 'text') node.text = replaceEdges(node.text, TEXT_EDGE, ' ');
        }
        return this.#row;
    }

    #push(node: MathNode, characters: number): void {
        bound(this.budget, this.depth, 1 + characters);
        this.#row.push(node);
    }

    #flush(): void {
        const chars = this.#chars;
        this.#chars = [];
        let start = 0;
        while (start < chars.length) {
            const { char, variant, color } = chars[start];
            const same = (index: number) => chars[index]?.variant === variant && chars[index].color === color;
            const run = (index: number, test: RegExp) => {
                let end = index;
                while (same(end) && test.test(chars[end].char)) end++;
                return end;
            };
            const space = SPACE_OF_CHAR.get(char);
            let end = start + 1;
            if (space) {
                const qquad = space === 'quad' && chars[end]?.char === SPACES.quad.text;
                this.#push({ kind: 'space', width: qquad ? 'qquad' : space }, 0);
                start = qquad ? end + 1 : end;
                continue;
            }
            if (DIGIT.test(char)) {
                end = run(end, DIGIT);
                if (same(end) && chars[end].char === '.' && same(end + 1) && DIGIT.test(chars[end + 1].char)) {
                    end = run(end + 1, DIGIT);
                }
            } else if (LETTER.test(char) && variant === 'normal') {
                end = run(end, LETTER);
            }
            const text = chars
                .slice(start, end)
                .map((styled) => styled.char)
                .join('');
            const node = DIGIT.test(char)
                ? token('number', text, variant === 'normal' ? undefined : variant, color)
                : LETTER.test(char)
                  ? token('identifier', text, end - start > 1 || variant === 'italic' ? undefined : variant, color)
                  : token('operator', text, variant === 'normal' ? undefined : variant, color);
            this.#push(node, text.length);
            start = end;
        }
    }
}
