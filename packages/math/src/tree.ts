import { MathError } from './error';
import { ACCENTS, fromAlphanumeric, SCRIPT_CHARS, SPACES, UPRIGHT_LETTERS } from './notation';
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

// `at` is where in its input a reader is, for a MathError's offset.
export type MathBudget = { size: number; at?: () => number };

// The fixture's 108 equations nest at most 7 deep and reach size 182: about 4.5× and 22× room.
const SIZE = 4_000;
// writeLatex's costliest unit, an enclose of every line around an empty row, writes 101 characters for 2 units.
const LATEX_LENGTH = 51 * SIZE;

export const MATH_LIMITS = {
    // Levels a reader walks: a node's row, or an element it reads through.
    depth: 32,
    // Every node, row, table row and character of text counts one.
    size: SIZE,
    latexLength: LATEX_LENGTH,
    // 64 characters a unit (an menclose of every line), the annotation escaped at six a character (&quot;), the root.
    mathmlLength: 64 * SIZE + 6 * LATEX_LENGTH + 512,
} as const;

// Every reader calls this as it builds: at each level it walks, and for each node, row and character it makes.
export function bound(budget: MathBudget, depth: number, size: number): void {
    budget.size += size;
    if (depth > MATH_LIMITS.depth)
        throw new MathError(`An equation nests at most ${MATH_LIMITS.depth} levels deep`, budget.at?.());
    if (budget.size > MATH_LIMITS.size)
        throw new MathError(`An equation holds at most ${MATH_LIMITS.size} parts`, budget.at?.());
}

// Variation selectors too: an emoji presentation is no math.
const INVISIBLE = /^(?:[\u200B\u2061-\u2064]|\uFE0E|\uFE0F)$/u;
const LETTER = /^\p{L}$/u;
const MARK = /^\p{M}$/u;
export const DIGIT = /^[0-9]$/;
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

// Each character with the combining marks after it: a token's letters, as a word counts them.
export const clusters = (text: string) => text.match(/\P{M}\p{M}*/gu) ?? [];

// The one character a fence, accent, brace or large operator holds; '' for none.
export function mark(text: string): string {
    const [char = ''] = checkedXml(trimXmlSpace(text));
    return INVISIBLE.test(char) ? '' : char;
}

export function toColor(hex: string | undefined): string | undefined {
    return hex && /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex.toUpperCase()}` : undefined;
}

// A #RRGGBB colour, as MathML, LaTeX and a tree hold it; anything else is no colour, so a writer never writes it.
export const hexColor = (color: string | undefined) => (color?.startsWith('#') ? toColor(color.slice(1)) : undefined);

// What a token is without a variant: italic for one letter but upright for a capital Greek one, upright for the rest.
export function defaultVariant(kind: MathToken['kind'], text: string): MathVariant {
    const [first] = text;
    return kind === 'identifier' && clusters(text).length === 1 && !UPRIGHT_LETTERS.has(first) ? 'italic' : 'normal';
}

function token(kind: MathToken['kind'], text: string, variant: MathVariant, color: string | undefined): MathToken {
    const node: MathToken = { kind, text };
    if (variant !== defaultVariant(kind, text)) node.variant = variant;
    if (color) node.color = color;
    return node;
}

// A text node's text: a tab or line break is a space, as MathML would trim it at an edge.
export const mathText = (raw: string) => checkedXml(raw).replace(/[\t\n\r]/g, ' ');

// A number is digits, then a point and digits if any follow: where the one starting at `start` ends.
export function numberEnd(start: number, digit: (index: number) => boolean, point: (index: number) => boolean): number {
    let end = start + 1;
    while (digit(end)) end++;
    if (point(end) && digit(end + 1)) for (end += 2; digit(end); end++);
    return end;
}

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

type StyledChar = { char: string; marks: string; variant: MathVariant; color: string | undefined };

// The MathML writer keeps a text's edge spaces as no-break spaces; they read back as spaces.
const TEXT_EDGE: ReadonlySet<string> = new Set(' \u00A0');

// How a row counts: an optional slot only when it holds something, an equation's & as the cell it starts.
export type RowSlot = 'required' | 'optional' | 'equation';

// Characters wait for the next node, so tokens come out canonical however runs or elements split them.
export class RowBuilder {
    readonly #row: MathRow = [];
    #chars: StyledChar[] = [];
    // Characters and marks waiting in #chars.
    #waiting = 0;

    constructor(
        readonly budget: MathBudget,
        readonly depth: number,
        readonly slot: RowSlot = 'required',
    ) {
        bound(budget, depth, slot === 'optional' ? 0 : 1);
    }

    // Without `letters`, each letter takes its default.
    chars(text: string, letters: MathVariant | undefined, others: MathVariant, color: string | undefined): void {
        for (const char of checkedXml(text)) {
            if (INVISIBLE.test(char)) continue;
            const last = this.#chars.at(-1);
            if (MARK.test(char)) {
                // A combining mark joins the character before it; after a space or nothing it marks nothing.
                if (!last || SPACE_OF_CHAR.has(last.char)) continue;
                last.marks += char;
            } else {
                const [base, variant] = fromAlphanumeric(char) ?? [
                    char,
                    LETTER.test(char) ? (letters ?? defaultVariant('identifier', char)) : others,
                ];
                this.#chars.push({ char: base, marks: '', variant, color });
            }
            // Every two waiting characters or marks make at least one part (two quads are one qquad): bound them as
            // they come.
            if (this.budget.size + ++this.#waiting / 2 > MATH_LIMITS.size)
                bound(this.budget, this.depth, MATH_LIMITS.size);
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
        if (this.slot === 'optional' && this.#row.length > 0) bound(this.budget, this.depth, 1);
        for (const node of this.#row) {
            if (node.kind === 'text') node.text = replaceEdges(node.text, TEXT_EDGE, ' ');
        }
        return this.#row;
    }

    #push(node: MathNode, characters: number): void {
        const cell = this.slot === 'equation' && node.kind === 'operator' && node.text === '&';
        bound(this.budget, this.depth, cell ? 1 : 1 + characters);
        this.#row.push(node);
    }

    #flush(): void {
        const chars = this.#chars;
        this.#chars = [];
        this.#waiting = 0;
        let start = 0;
        while (start < chars.length) {
            const { char, marks, variant, color } = chars[start];
            // A marked character is a token of its own.
            const same = (index: number) =>
                chars[index]?.marks === '' && chars[index].variant === variant && chars[index].color === color;
            const run = (index: number, test: RegExp) => {
                let end = index;
                while (same(end) && test.test(chars[end].char)) end++;
                return end;
            };
            if (SCRIPT_CHARS.has(char)) {
                start = this.#scripts(chars, start);
                continue;
            }
            if (marks !== '') {
                this.#marked(char, marks, variant, color);
                start++;
                continue;
            }
            const space = SPACE_OF_CHAR.get(char);
            let end = start + 1;
            if (space) {
                const qquad = space === 'quad' && chars[end]?.char === SPACES.quad.text;
                this.#push({ kind: 'space', width: qquad ? 'qquad' : space }, 0);
                start = qquad ? end + 1 : end;
                continue;
            }
            if (DIGIT.test(char)) {
                end = numberEnd(
                    start,
                    (index) => same(index) && DIGIT.test(chars[index].char),
                    (index) => same(index) && chars[index].char === '.',
                );
            } else if (LETTER.test(char) && variant === 'normal') {
                end = run(end, LETTER);
            }
            const text = chars
                .slice(start, end)
                .map((styled) => styled.char)
                .join('');
            const kind = DIGIT.test(char) ? 'number' : LETTER.test(char) ? 'identifier' : 'operator';
            this.#push(token(kind, text, variant, color), text.length);
            start = end;
        }
    }

    // A run of script characters (x², x₁₂) is one scripts node on the token before it, else on an empty base. Their
    // marks go with them into the script.
    #scripts(chars: StyledChar[], start: number): number {
        const rows = {
            sub: new RowBuilder(this.budget, this.depth + 1, 'optional'),
            sup: new RowBuilder(this.budget, this.depth + 1, 'optional'),
        };
        let end = start;
        for (; end < chars.length; end++) {
            const { char, marks, variant, color } = chars[end];
            const script = SCRIPT_CHARS.get(char);
            if (!script) break;
            rows[script[0]].chars(script[1] + marks, variant, variant, color);
        }
        const last = this.#row.at(-1);
        const base = last?.kind === 'identifier' || last?.kind === 'number' || last?.kind === 'operator' ? [last] : [];
        if (base.length > 0) this.#row.pop();
        bound(this.budget, this.depth + 1, 1);
        const node: MathNode = { kind: 'scripts', base };
        const sub = optional(rows.sub.done());
        const sup = optional(rows.sup.done());
        if (sub) node.sub = sub;
        if (sup) node.sup = sup;
        this.#push(node, 0);
        return end;
    }

    // An accent mark is an accent over the character, innermost first; any other stays with it, composed by NFC.
    #marked(char: string, marks: string, variant: MathVariant, color: string | undefined): void {
        const accents = [...marks].filter((mark) => ACCENTS.has(mark));
        const text = (char + [...marks].filter((mark) => !ACCENTS.has(mark)).join('')).normalize('NFC');
        const [first] = text;
        let node: MathNode = token(
            DIGIT.test(text) ? 'number' : LETTER.test(first) ? 'identifier' : 'operator',
            text,
            variant,
            color,
        );
        for (const accent of accents) node = { kind: 'accent', accent, body: [node] };
        // Each accent adds a node over a row of its own, a level deeper.
        if (accents.length > 0) bound(this.budget, this.depth + accents.length, 2 * accents.length + text.length);
        this.#push(node, accents.length > 0 ? 0 : text.length);
    }
}
