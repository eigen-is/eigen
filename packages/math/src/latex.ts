// readLatex and writeLatex: the LaTeX a person types, read into the tree and written back out. The reader is a
// tokenizer that pairs every brace, \left and \begin up front, then a recursive-descent parser over a small TeX
// subset. The writer writes the same subset and marks the tree where LaTeX alone is ambiguous. Both go through
// LATEX_COMMANDS, so a new command is a row in that table, not code.

import { MathError } from './error';
import type { LatexCommand } from './latex-commands';
import { BARE_ENVIRONMENTS, LATEX_COMMANDS, LATEX_ENVIRONMENTS } from './latex-commands';
import { ACCENTS, COLOR_NAMES, isNoLine, MINUS, naryLimits, PRIME, SPACES } from './notation';
import type { MathBudget, MathNode, MathRow, MathToken, MathVariant, RowSlot } from './tree';
import {
    bound,
    clusters,
    DIGIT,
    defaultVariant,
    equationCells,
    hexColor,
    MARK,
    MATH_ENCLOSURES,
    MATH_LIMITS,
    mark,
    numberEnd,
    optional,
    RowBuilder,
} from './tree';
import { checkedXml, NOT_XML } from './xml';

const NO_BREAK_SPACE = '\u00A0';
// The slash \not puts through a symbol.
const NOT = '\u0338';

// The fence characters a \left, \middle or \right takes as they are; the rest are commands.
const DELIMITER_CHARS: ReadonlySet<string> = new Set('()[]|/');

// What \text needs escaped, and the text-mode commands the reader takes back.
const TEXT_ESCAPES: Readonly<Record<string, string>> = {
    '\\': '\\textbackslash{}',
    '^': '\\textasciicircum{}',
    '~': '\\textasciitilde{}',
    '{': '\\{',
    '}': '\\}',
    '%': '\\%',
    '&': '\\&',
    '#': '\\#',
    $: '\\$',
    _: '\\_',
    [NO_BREAK_SPACE]: '~',
};
const TEXT_COMMANDS: ReadonlyMap<string, string> = new Map(
    Object.entries(TEXT_ESCAPES).flatMap(([char, escaped]) => {
        const word = /^\\([A-Za-z]+)/.exec(escaped)?.[1];
        return word ? [[word, char]] : [];
    }),
);

// ── Reader ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Token = { text: string; at: number; command: boolean; space: boolean };

// `letters` undefined is math's default: italic, but upright for a capital Greek letter, as TeX draws it. `hyphen` is
// \operatorname's: a - between letters there is a hyphen, as amsmath draws it, and the minus sign elsewhere.
type Style = { letters: MathVariant | undefined; others: MathVariant; color: string | undefined; hyphen?: true };

// What an atom adds to its row. Characters wait in the row's builder, so tokens come out canonical across atoms.
type Piece = { chars: string; style: Style } | { text: string; color: string | undefined } | { node: MathNode };

const MATH: Style = { letters: undefined, others: 'normal', color: undefined };

// Leading spaces, then a comment, a control word or space with TeX's skipped spaces, a control symbol, or a character
// with its combining marks; a mark after a character the parser reads as structure is a token of its own.
const TOKEN =
    /([ \t\r\n]*)(?:(%[^\n]*\n?[ \t]*)|\\([A-Za-z]+)[ \t\r\n]*|\\([ \t\r\n])[ \t\r\n]*|\\(.)|([{}[\]^_&'~]|[^ \t\r\n]\p{M}*))/suy;

const CLOSERS: ReadonlyMap<string, string> = new Map([
    ['{', '}'],
    ['\\left', '\\right'],
    ['\\begin', '\\end'],
]);
const OPENERS: ReadonlyMap<string, string> = new Map(Array.from(CLOSERS, ([opener, closer]) => [closer, opener]));

const describe = (token: Token) => (token.command ? `\\${token.text}` : token.text);

// Pairs each brace, \left and \begin with its partner, so a reader knows where an argument ends before reading it.
function tokenize(latex: string): { tokens: Token[]; partners: number[] } {
    const invalid = latex.search(NOT_XML);
    if (invalid >= 0) throw new MathError('LaTeX holds a character an equation can’t', invalid);
    const tokens: Token[] = [];
    const partners: number[] = [];
    const open: number[] = [];
    let space = false;
    TOKEN.lastIndex = 0;
    for (let found = TOKEN.exec(latex); found; found = TOKEN.exec(latex)) {
        const [, spaces, comment, word, blank, symbol, char] = found;
        space ||= spaces !== '';
        if (comment !== undefined) continue;
        const at = found.index + spaces.length;
        if (char === '\\') throw new MathError('A backslash ends the LaTeX', at);
        if (LATEX_COMMANDS.get(word ?? symbol ?? '')?.kind === 'noop') continue;
        const token = {
            text: word ?? (blank === undefined ? (symbol ?? char) : ' '),
            at,
            command: char === undefined,
            space,
        };
        space = false;
        const index = tokens.push(token) - 1;
        const key = describe(token);
        if (CLOSERS.has(key)) open.push(index);
        const opener = OPENERS.get(key);
        if (opener === undefined) continue;
        const partner = open.pop();
        if (partner === undefined || describe(tokens[partner]) !== opener)
            throw new MathError(`A ${key} without its ${opener}`, at);
        partners[partner] = index;
        partners[index] = partner;
    }
    const unclosed = open.pop();
    if (unclosed !== undefined) {
        const key = describe(tokens[unclosed]);
        throw new MathError(`A ${key} without its ${CLOSERS.get(key)}`, tokens[unclosed].at);
    }
    return { tokens, partners };
}

// The character a token stands for in math: a character, a symbol or a space; '' for anything else.
function charOf(token: Token): string {
    if (!token.command) return token.text === "'" ? PRIME : token.text === '~' ? SPACES.normal.text : token.text;
    const command = LATEX_COMMANDS.get(token.text);
    if (command?.kind === 'symbol') return command.char;
    return command?.kind === 'space' ? SPACES[command.width].text : '';
}

function delimiterOf(token: Token): string | undefined {
    if (!token.command) return token.text === '.' ? '' : DELIMITER_CHARS.has(token.text) ? token.text : undefined;
    const command = LATEX_COMMANDS.get(token.text);
    return command?.kind === 'symbol' && command.class === 'delimiter' ? command.char : undefined;
}

const LANGLE = '⟨';
const RANGLE = '⟩';

// A bra-ket's fenced row, its parts between bars.
const barred = (open: string, close: string, parts: MathRow[]): MathNode => ({
    kind: 'fenced',
    open,
    close,
    separator: parts.length > 1 ? '|' : '',
    parts,
});

// The units KaTeX and MathJax share.
const DIMENSION = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|mm|cm|in|pc|px|em|ex|mu)\s*$/;

// What a function name or large operator never takes as its body: a lone operator or space.
const LONE = /^[^\p{L}0-9]+$/u;

class LatexReader {
    readonly #budget: MathBudget = { size: 0, at: () => this.#offset(this.#pos) };
    readonly #latex: string;
    readonly #tokens: Token[];
    readonly #partners: number[];
    #pos = 0;
    // A window: an argument, a fenced part or a cell is read up to here.
    #end: number;
    // Groups, fonts and colours read into the row around them: levels the parser walks that the tree doesn't have.
    #wrappers = 0;

    public constructor(latex: string) {
        this.#latex = latex;
        ({ tokens: this.#tokens, partners: this.#partners } = tokenize(latex));
        this.#end = this.#tokens.length;
    }

    public read(): MathRow {
        const pieces: Piece[] = [];
        this.#atoms(pieces, MATH, 1);
        if (this.#pos < this.#end) throw this.#unexpected(this.#pos);
        return this.#build(pieces, 1);
    }

    #build(pieces: Piece[], depth: number, slot?: RowSlot): MathRow {
        const row = new RowBuilder(this.#budget, depth, slot);
        for (const piece of pieces) {
            if ('node' in piece) row.node(piece.node);
            else if ('chars' in piece) {
                const { letters, others, color, hyphen } = piece.style;
                row.chars(hyphen ? piece.chars : piece.chars.replaceAll('-', MINUS), letters, others, color);
            } else row.text(piece.text, piece.color);
        }
        return row.done();
    }

    #offset(index: number): number {
        return index < this.#tokens.length ? this.#tokens[index].at : this.#latex.length;
    }

    #unexpected(index: number): MathError {
        return new MathError(`Unexpected ${describe(this.#tokens[index])}`, this.#tokens[index].at);
    }

    #isChar(index: number, char: string): boolean {
        return index < this.#end && !this.#tokens[index].command && this.#tokens[index].text === char;
    }

    #commandAt(index: number): LatexCommand | undefined {
        return index < this.#end && this.#tokens[index].command
            ? LATEX_COMMANDS.get(this.#tokens[index].text)
            : undefined;
    }

    #isStop(index: number): boolean {
        const token = this.#tokens[index];
        return token.command ? token.text === '\\' || token.text === 'middle' : token.text === '&';
    }

    #isScriptAt(index: number): boolean {
        return this.#isChar(index, '^') || this.#isChar(index, '_');
    }

    // A token of combining marks alone, which join the character before them.
    #isMark(index: number): boolean {
        return index < this.#end && !this.#tokens[index].command && /^\p{M}/u.test(this.#tokens[index].text);
    }

    #isDigit(index: number): boolean {
        return index < this.#end && !this.#tokens[index].command && DIGIT.test(this.#tokens[index].text);
    }

    // A group, a command with its own arguments (x_\text{max}) or one character.
    #argumentEnd(index: number, nesting: number): number {
        if (this.#isChar(index, '{')) return this.#partners[index] + 1;
        return index < this.#end && this.#tokens[index].command ? this.#atomEnd(index, nesting + 1) : index + 1;
    }

    // TeX ends an optional argument at the first ] outside braces.
    #bracketEnd(index: number, nesting: number): number {
        if (!this.#isChar(index, '[')) return index;
        let close = index + 1;
        while (close < this.#end && !this.#isChar(close, ']')) close = this.#argumentEnd(close, nesting);
        if (close >= this.#end) throw new MathError('A [ without its ]', this.#tokens[index].at);
        return close + 1;
    }

    // Where the atom at `index` ends, so a reader knows before reading it whether scripts make it a base.
    #atomEnd(index: number, nesting: number): number {
        const token = this.#tokens[index];
        // Each command in an unbraced argument is a level or a wrapper, so the walk ends within both bounds.
        if (nesting > 2 * MATH_LIMITS.depth)
            throw new MathError(`An equation nests at most ${MATH_LIMITS.depth} levels deep`, token.at);
        if (!token.command) return this.#argumentEnd(index, nesting);
        const command = LATEX_COMMANDS.get(token.text);
        if (!command) return index + 1;
        let end = index + 1;
        switch (command.kind) {
            case 'left':
                return this.#partners[index] + 2;
            case 'begin':
                return this.#argumentEnd(this.#partners[index] + 1, nesting);
            case 'big':
                return end + 1;
            case 'not':
                while (this.#commandAt(end)?.kind === 'not') end++;
                for (end++; this.#isMark(end); end++);
                return end;
            case 'radical':
            case 'arrow':
                end = this.#bracketEnd(end, nesting);
                break;
            case 'operatorname':
                if (this.#isChar(end, '*')) end++;
                break;
            case 'expectation':
            case 'outerProduct':
                end = this.#argumentEnd(this.#starred(end, command.stars), nesting);
                return this.#isChar(end, '{') ? this.#argumentEnd(end, nesting) : end;
            case 'braket': {
                end = this.#starred(end, command.stars);
                const ket = this.#ketAt(command, end, nesting);
                if (ket === undefined) break;
                return this.#isChar(ket, '{') ? this.#argumentEnd(ket, nesting) : ket;
            }
            case 'matrixElement':
                end = this.#starred(end, command.stars);
        }
        for (let argument = 0; argument < command.arguments; argument++) end = this.#argumentEnd(end, nesting);
        return end;
    }

    // Where up to `stars` stars after a physics command end; they only size its fences.
    #starred(index: number, stars: number): number {
        let end = index;
        while (end < index + stars && this.#isChar(end, '*')) end++;
        return end;
    }

    // Each | at the top of the argument at `index`, where a \braket or \set splits it.
    #bars(index: number, nesting: number): number[] {
        const braced = this.#isChar(index, '{');
        const end = Math.min(braced ? this.#partners[index] : this.#argumentEnd(index, nesting), this.#end);
        const bars: number[] = [];
        for (let at = braced ? index + 1 : index; at < end; at = this.#atomEnd(at, nesting + 1)) {
            if (this.#isChar(at, '|')) bars.push(at);
        }
        return bars;
    }

    // Where the ket starts that physics joins to the bra-ket argument at `index`, which makes ⟨a|b⟩. A \ket right after
    // \bra{a} joins, and so does a group right after a \braket{a} that has no bar. Physics reads only a group as the
    // ket's argument, so `\bra{a}\ket\psi` is ⟨a|⟩ followed by ψ. Undefined where nothing joins.
    #ketAt(command: Extract<LatexCommand, { kind: 'braket' }>, index: number, nesting: number): number | undefined {
        const end = this.#argumentEnd(index, nesting);
        const next = this.#commandAt(end);
        if (command.join === 'ket' && next?.kind === 'braket' && this.#tokens[end].text === command.join)
            return this.#starred(end + 1, next.stars);
        if (command.join === 'group' && this.#isChar(end, '{') && this.#bars(index, nesting).length === 0) return end;
        return undefined;
    }

    // A base sits a level below the node its scripts make, two below when both are limits.
    #baseDepth(index: number, limits: boolean, depth: number): number {
        if (!this.#isScriptAt(index)) return depth;
        return depth + (limits && this.#isScriptAt(this.#argumentEnd(index + 1, 0)) ? 2 : 1);
    }

    #within(start: number, end: number, read: () => void): void {
        // A command's arguments may run past the window it stands in.
        if (end > this.#end) throw new MathError('An argument is missing', this.#offset(this.#end));
        const outer = this.#end;
        this.#pos = start;
        this.#end = end;
        read();
        if (this.#pos < end) throw this.#unexpected(this.#pos);
        this.#end = outer;
    }

    // An argument: a group, or one token that takes none of its own.
    #window(read: () => void): void {
        const start = this.#pos;
        if (start >= this.#end) throw new MathError('An argument is missing', this.#offset(start));
        const end = this.#argumentEnd(start, 0);
        if (this.#isChar(start, '{')) this.#within(start + 1, end - 1, read);
        else this.#within(start, end, read);
        this.#pos = end;
    }

    #argument(into: Piece[], style: Style, depth: number): void {
        this.#window(() => this.#atoms(into, style, depth));
    }

    #spliced(into: Piece[], style: Style, depth: number): void {
        this.#wrappers++;
        bound(this.#budget, this.#wrappers, 0);
        this.#argument(into, style, depth);
        this.#wrappers--;
    }

    #row(style: Style, depth: number): MathRow {
        const pieces: Piece[] = [];
        this.#argument(pieces, style, depth);
        return this.#build(pieces, depth);
    }

    #optional(style: Style, depth: number): MathRow | undefined {
        const pieces: Piece[] = [];
        this.#argument(pieces, style, depth);
        return optional(this.#build(pieces, depth, 'optional'));
    }

    #bracketed(style: Style, depth: number): MathRow | undefined {
        const end = this.#bracketEnd(this.#pos, 0);
        if (end === this.#pos) return undefined;
        // One group, as writeLatex braces a degree, is the row itself, as #scripted reads a braced base.
        const group = this.#isChar(this.#pos + 1, '{') && this.#partners[this.#pos + 1] === end - 2;
        const inner = group ? 2 : 1;
        const pieces: Piece[] = [];
        this.#within(this.#pos + inner, end - inner, () => this.#atoms(pieces, style, depth));
        this.#pos = end;
        return optional(this.#build(pieces, depth, 'optional'));
    }

    // A group of one combining mark alone: the mark, the group read.
    #loneMark(): string | undefined {
        const token = this.#tokens[this.#pos + 1];
        if (!this.#isChar(this.#pos, '{') || this.#partners[this.#pos] !== this.#pos + 2 || token.command)
            return undefined;
        if (!MARK.test(token.text) || mark(token.text) === '') return undefined;
        this.#pos += 3;
        return token.text;
    }

    // A braced argument as written: a colour, an enclosure's notation, a fraction's line, an environment's name.
    #raw(): string {
        const open = this.#pos;
        if (open >= this.#end) throw new MathError('An argument is missing', this.#offset(open));
        if (!this.#isChar(open, '{')) throw new MathError('Braces expected', this.#tokens[open].at);
        const close = this.#partners[open];
        this.#pos = close + 1;
        return this.#latex.slice(this.#tokens[open].at + 1, this.#tokens[close].at).trim();
    }

    #color(): string {
        const at = this.#offset(this.#pos) + 1;
        const name = this.#raw();
        const color = hexColor(name) ?? COLOR_NAMES.get(name);
        if (!color) throw new MathError(`Unknown colour ${name}`, at);
        return color;
    }

    #delimiter(): string {
        if (this.#pos >= this.#end) throw new MathError('A delimiter is missing', this.#offset(this.#pos));
        const token = this.#tokens[this.#pos++];
        const char = delimiterOf(token);
        if (char === undefined) throw new MathError(`${describe(token)} is no delimiter`, token.at);
        return char;
    }

    // \text's argument as TeX reads it in text mode: a run of spaces is one space, ~ a no-break space.
    #text(): string {
        let text = '';
        const start = this.#pos;
        this.#window(() => {
            for (; this.#pos < this.#end; this.#pos++) {
                const token = this.#tokens[this.#pos];
                if (token.space && this.#pos > start) text += ' ';
                const char = token.command
                    ? (TEXT_COMMANDS.get(token.text) ?? charOf(token))
                    : token.text === '~'
                      ? NO_BREAK_SPACE
                      : token.text;
                if (char === '') throw new MathError(`${describe(token)} can’t stand in text`, token.at);
                // A brace groups; \{ and \} are the characters.
                if (token.command || !/^[{}]$/.test(char)) text += char;
            }
        });
        // The closing brace carries the spaces before it.
        if (this.#isChar(start, '{') && this.#tokens[this.#pos - 1].space) text += ' ';
        return text;
    }

    // The style a \color left in force, which a \middle carries on.
    #atoms(into: Piece[], style: Style, depth: number): Style {
        let current = style;
        while (this.#pos < this.#end && !this.#isStop(this.#pos)) {
            if (this.#commandAt(this.#pos)?.kind === 'colorSwitch') {
                this.#pos++;
                current = { ...current, color: this.#color() };
            } else this.#scripted(into, current, depth);
        }
        return current;
    }

    // One atom and its scripts. Functions, large operators and braces read their own.
    #scripted(into: Piece[], style: Style, depth: number): void {
        const kind = this.#commandAt(this.#pos)?.kind;
        if (kind === 'function' || kind === 'operatorname' || kind === 'largeOperator' || kind === 'brace') {
            this.#atom(into, style, depth);
            return;
        }
        const base: Piece[] = [];
        if (!this.#isScriptAt(this.#pos)) {
            const baseDepth = this.#baseDepth(this.#atomEnd(this.#pos, 0), false, depth);
            // A braced base is the base's row, not a group read into the row around it.
            if (baseDepth > depth && this.#isChar(this.#pos, '{')) this.#argument(base, style, baseDepth);
            else this.#atom(base, style, baseDepth);
        }
        this.#attach(into, base, false, style, depth);
    }

    #scripts(style: Style, subDepth: number, supDepth: number): { sub?: MathRow; sup?: MathRow } {
        const scripts: { sub?: MathRow; sup?: MathRow } = {};
        while (this.#isScriptAt(this.#pos)) {
            const token = this.#tokens[this.#pos++];
            const slot = token.text === '^' ? 'sup' : 'sub';
            if (slot in scripts)
                throw new MathError(`A second ${slot === 'sup' ? 'superscript' : 'subscript'}`, token.at);
            scripts[slot] = this.#optional(style, slot === 'sup' ? supDepth : subDepth);
        }
        return scripts;
    }

    // The scripts after a base: a scripts node, or for limits a limit under inside a limit over.
    #attach(into: Piece[], base: Piece[], limits: boolean, style: Style, depth: number): void {
        const both = limits && this.#isScriptAt(this.#argumentEnd(this.#pos + 1, 0));
        const { sub, sup } = this.#scripts(style, depth + (both ? 2 : 1), depth + 1);
        if (!sub && !sup) {
            for (const piece of base) into.push(piece);
            return;
        }
        if (!limits) {
            const node: MathNode = { kind: 'scripts', base: this.#build(base, depth + 1) };
            if (sub) node.sub = sub;
            if (sup) node.sup = sup;
            into.push({ node });
            return;
        }
        const under: Piece[] = sub
            ? [
                  {
                      node: {
                          kind: 'limit',
                          position: 'under',
                          base: this.#build(base, depth + (sup ? 2 : 1)),
                          limit: sub,
                      },
                  },
              ]
            : base;
        if (sup)
            into.push({ node: { kind: 'limit', position: 'over', base: this.#build(under, depth + 1), limit: sup } });
        else for (const piece of under) into.push(piece);
    }

    // \sin(x) is the name, then (x): a lone operator or space is no body. A number is whole, as Word builds it.
    #body(style: Style, depth: number): MathRow | undefined {
        if (this.#pos >= this.#end || this.#isStop(this.#pos)) return undefined;
        const pieces: Piece[] = [];
        if (this.#isChar(this.#pos, '{')) this.#argument(pieces, style, depth);
        else if (LONE.test(charOf(this.#tokens[this.#pos]))) return undefined;
        else if (this.#isDigit(this.#pos)) {
            let end = numberEnd(
                this.#pos,
                (index) => this.#isDigit(index),
                (index) => this.#isChar(index, '.'),
            );
            while (this.#isScriptAt(end)) end = this.#argumentEnd(end + 1, 0);
            this.#within(this.#pos, end, () => this.#atoms(pieces, style, depth));
        } else this.#scripted(pieces, style, depth);
        return this.#build(pieces, depth);
    }

    #function(
        into: Piece[],
        command: Extract<LatexCommand, { kind: 'function' | 'operatorname' }>,
        name: string,
        style: Style,
        depth: number,
    ): void {
        const upright: Style = { ...style, letters: 'normal', others: 'normal', hyphen: true };
        // \operatorname* puts its scripts under and over, as \lim does; \limits and \nolimits choose.
        const star = command.kind === 'operatorname' && this.#isChar(this.#pos, '*');
        if (star) this.#pos++;
        const nameEnd = command.kind === 'function' ? this.#pos : this.#argumentEnd(this.#pos, 0);
        const explicit = this.#commandAt(nameEnd);
        const limits =
            explicit?.kind === 'limits'
                ? explicit.limits === 'under'
                : command.kind === 'function'
                  ? command.limits
                  : star;
        const scriptsAt = explicit?.kind === 'limits' ? nameEnd + 1 : nameEnd;
        const head: Piece[] = [];
        if (command.kind === 'function') head.push({ chars: name, style: upright });
        else this.#argument(head, upright, this.#baseDepth(scriptsAt, limits, depth + 1));
        this.#pos = scriptsAt;
        const named: Piece[] = [];
        this.#attach(named, head, limits, style, depth + 1);
        const body = this.#body(style, depth + 1);
        if (body) into.push({ node: { kind: 'function', name: this.#build(named, depth + 1), body } });
        else for (const piece of named) into.push(piece);
    }

    // A large operator takes its scripts and then the next atom as its body; with neither it is the operator alone.
    #largeOperator(into: Piece[], operator: string, style: Style, depth: number): void {
        const command = this.#commandAt(this.#pos);
        const explicit = command?.kind === 'limits' ? command.limits : undefined;
        if (explicit) this.#pos++;
        const { sub, sup } = this.#scripts(style, depth + 1, depth + 1);
        const body = this.#body(style, depth + 1);
        if (!sub && !sup && !body) {
            into.push({ chars: operator, style });
            return;
        }
        const node: MathNode = {
            kind: 'nary',
            operator,
            limits: sub || sup ? (explicit ?? naryLimits(operator)) : naryLimits(operator),
            body: body ?? this.#build([], depth + 1),
        };
        if (sub) node.sub = sub;
        if (sup) node.sup = sup;
        into.push({ node });
    }

    // A fraction or table inside fences, as \binom, \genfrac and pmatrix write them; bare without fences.
    #fence(node: MathNode, open: string, close: string, depth: number): MathNode {
        if (open === '' && close === '') return node;
        return { kind: 'fenced', open, close, separator: '', parts: [this.#build([{ node }], depth + 1)] };
    }

    #fraction(open: string, close: string, line: 'bar' | 'none', style: Style, depth: number): MathNode {
        const inner = depth + (open === '' && close === '' ? 1 : 2);
        const numerator = this.#row(style, inner);
        return this.#fence(
            { kind: 'fraction', numerator, denominator: this.#row(style, inner), line },
            open,
            close,
            depth,
        );
    }

    // \genfrac's delimiter: an empty group or one delimiter token.
    #genfracDelimiter(): string {
        const open = this.#pos;
        const at = this.#offset(open);
        this.#raw();
        if (this.#pos === open + 2) return '';
        const char = this.#pos === open + 3 ? delimiterOf(this.#tokens[open + 1]) : undefined;
        if (char === undefined) throw new MathError('A delimiter is missing', at);
        return char;
    }

    #fenced(style: Style, depth: number): MathNode {
        const left = this.#pos - 1;
        const right = this.#partners[left];
        if (right >= this.#end) throw new MathError('A \\left without its \\right', this.#tokens[left].at);
        const open = this.#delimiter();
        const parts: MathRow[] = [];
        let separator: string | undefined;
        this.#within(this.#pos, right, () => {
            let current = style;
            let pieces: Piece[] = [];
            for (;;) {
                current = this.#atoms(pieces, current, depth + 1);
                if (this.#pos >= this.#end) break;
                if (this.#commandAt(this.#pos)?.kind !== 'middle') throw this.#unexpected(this.#pos);
                this.#pos++;
                const middle = this.#delimiter();
                separator ??= middle;
                // The tree holds one separator: a different one stays a character in its part.
                if (middle !== separator) pieces.push({ chars: middle, style: current });
                else {
                    parts.push(this.#build(pieces, depth + 1));
                    pieces = [];
                }
            }
            parts.push(this.#build(pieces, depth + 1));
        });
        this.#pos = right + 1;
        const close = this.#delimiter();
        return { kind: 'fenced', open, close, separator: parts.length > 1 ? (separator ?? '') : '', parts };
    }

    // A bra-ket's argument as the parts of a fenced row. Where the command splits, each | at the top of the argument is
    // a separator, as \Braket makes it a \middle|. A | inside a group, or a delimiter's own, stays a character.
    #braket(open: string, close: string, split: boolean, style: Style, depth: number): MathNode {
        const bars = split ? this.#bars(this.#pos, 0) : [];
        const parts: MathRow[] = [];
        this.#window(() => {
            let current = style;
            for (const bar of [...bars, this.#end]) {
                const pieces: Piece[] = [];
                this.#within(this.#pos, bar, () => {
                    current = this.#atoms(pieces, current, depth + 1);
                });
                parts.push(this.#build(pieces, depth + 1));
                this.#pos = Math.min(bar + 1, this.#end);
            }
        });
        return barred(open, close, parts);
    }

    // physics repeats an argument, such as the state in ⟨ψ|A|ψ⟩. Both parts hold the one row, read once, so it counts
    // again toward the size bound, as in the tree a writer writes.
    #again(row: MathRow, before: number, depth: number): MathRow {
        bound(this.#budget, depth, this.#budget.size - before);
        return row;
    }

    // A row gap: the tree keeps none, but it must be a dimension KaTeX and MathJax both read.
    #gap(): void {
        const open = this.#pos;
        this.#pos = this.#bracketEnd(open, 0);
        const gap = this.#latex.slice(this.#tokens[open].at + 1, this.#tokens[this.#pos - 1].at);
        if (!DIMENSION.test(gap)) throw new MathError('A row gap is a dimension, such as 2pt', this.#tokens[open].at);
    }

    #environment(style: Style, depth: number): MathNode {
        const begin = this.#pos - 1;
        const end = this.#partners[begin];
        if (end >= this.#end) throw new MathError('A \\begin without its \\end', this.#tokens[begin].at);
        const nameAt = this.#offset(this.#pos) + 1;
        const name = this.#raw();
        const environment = LATEX_ENVIRONMENTS.get(name);
        if (!environment) throw new MathError(`Unknown environment ${name}`, nameAt);
        const fenced = environment.open !== '' || environment.close !== '';
        const cellDepth = depth + (fenced ? 2 : 1);
        const rows: MathRow[][] = [];
        this.#within(this.#pos, end, () => {
            let cells: MathRow[] = [];
            bound(this.#budget, cellDepth, 1);
            for (;;) {
                const pieces: Piece[] = [];
                this.#atoms(pieces, style, cellDepth);
                cells.push(this.#build(pieces, cellDepth));
                if (this.#pos >= this.#end) break;
                // & starts the next cell, \\ the next row; a \middle has no fence here.
                const token = this.#tokens[this.#pos++];
                if (token.command && token.text === 'middle') throw this.#unexpected(this.#pos - 1);
                if (!token.command) continue;
                // \\* and \\[2pt] only space the rows, and only a * or [ right after the \\, as amsmath reads it.
                if (this.#isChar(this.#pos, '*') && !this.#tokens[this.#pos].space) this.#pos++;
                if (this.#isChar(this.#pos, '[') && !this.#tokens[this.#pos].space) this.#gap();
                // A \\ after the last row starts none, as KaTeX and MathJax read it.
                rows.push(cells);
                cells = [];
                if (this.#pos >= this.#end) return;
                bound(this.#budget, cellDepth, 1);
            }
            rows.push(cells);
        });
        this.#pos = end + 1;
        const closingAt = this.#offset(this.#pos) + 1;
        const closing = this.#raw();
        if (closing !== name) throw new MathError(`\\end{${closing}} closes \\begin{${name}}`, closingAt);
        const table: MathNode = {
            kind: 'table',
            layout: environment.layout,
            rows: environment.layout === 'equations' ? rows.map((cells) => cells.flatMap(equationCells)) : rows,
        };
        return this.#fence(table, environment.open, environment.close, depth);
    }

    #atom(into: Piece[], style: Style, depth: number): void {
        bound(this.#budget, depth, 0);
        const token = this.#tokens[this.#pos];
        if (this.#isChar(this.#pos, '{')) {
            this.#spliced(into, style, depth);
            return;
        }
        this.#pos++;
        if (!token.command) {
            into.push({ chars: charOf(token), style });
            return;
        }
        const command = LATEX_COMMANDS.get(token.text);
        if (!command) throw new MathError(`Unknown command \\${token.text}`, token.at);
        switch (command.kind) {
            case 'symbol':
            case 'space':
                into.push({ chars: charOf(token), style });
                return;
            case 'function':
            case 'operatorname':
                this.#function(into, command, token.text, style, depth);
                return;
            case 'largeOperator':
                this.#largeOperator(into, command.operator, style, depth);
                return;
            case 'brace': {
                const braceDepth = this.#baseDepth(this.#argumentEnd(this.#pos, 0), true, depth);
                const body = this.#row(style, braceDepth + 1);
                const brace: Piece = { node: { kind: 'brace', char: command.char, position: command.position, body } };
                this.#attach(into, [brace], true, style, depth);
                return;
            }
            case 'font':
                this.#spliced(into, { ...style, letters: command.variant, others: command.variant }, depth);
                return;
            case 'color':
                this.#spliced(into, { ...style, color: this.#color() }, depth);
                return;
            case 'text':
                into.push({ text: this.#text(), color: style.color });
                return;
            case 'accent':
                into.push({ node: { kind: 'accent', accent: command.accent, body: this.#row(style, depth + 1) } });
                return;
            case 'line':
                into.push({ node: { kind: 'line', position: command.position, body: this.#row(style, depth + 1) } });
                return;
            case 'limit': {
                // \overset of one combining mark is an accent outside the accent table, as writeLatex writes one.
                const accent = command.position === 'over' ? this.#loneMark() : undefined;
                if (accent) {
                    into.push({ node: { kind: 'accent', accent, body: this.#row(style, depth + 1) } });
                    return;
                }
                const limit = this.#row(style, depth + 1);
                const base = this.#row(style, depth + 1);
                into.push({ node: { kind: 'limit', position: command.position, base, limit } });
                return;
            }
            case 'arrow': {
                const arrow: Piece[] = [{ chars: command.char, style }];
                const below = this.#bracketed(style, depth + 2);
                const base: Piece[] = below
                    ? [
                          {
                              node: {
                                  kind: 'limit',
                                  position: 'under',
                                  base: this.#build(arrow, depth + 2),
                                  limit: below,
                              },
                          },
                      ]
                    : arrow;
                const limit = this.#row(style, depth + 1);
                into.push({ node: { kind: 'limit', position: 'over', base: this.#build(base, depth + 1), limit } });
                return;
            }
            case 'fraction':
                into.push({ node: this.#fraction(command.open, command.close, command.line, style, depth) });
                return;
            case 'genfrac': {
                const open = this.#genfracDelimiter();
                const close = this.#genfracDelimiter();
                const line = isNoLine(this.#raw()) ? 'none' : 'bar';
                this.#raw();
                into.push({ node: this.#fraction(open, close, line, style, depth) });
                return;
            }
            case 'radical': {
                const degree = this.#bracketed(style, depth + 1);
                const body = this.#row(style, depth + 1);
                into.push({ node: degree ? { kind: 'radical', body, degree } : { kind: 'radical', body } });
                return;
            }
            case 'prescript': {
                const sup = this.#optional(style, depth + 1);
                const sub = this.#optional(style, depth + 1);
                if (!sub && !sup) {
                    this.#spliced(into, style, depth);
                    return;
                }
                const node: MathNode = { kind: 'scripts', base: this.#row(style, depth + 1), pre: true };
                if (sub) node.sub = sub;
                if (sup) node.sup = sup;
                into.push({ node });
                return;
            }
            case 'enclose':
                into.push({
                    node: { kind: 'enclose', notation: [...command.notation], body: this.#row(style, depth + 1) },
                });
                return;
            case 'notation': {
                const names = this.#raw().split(/[\s,]+/);
                const notation = MATH_ENCLOSURES.filter((enclosure) => names.includes(enclosure));
                into.push({ node: { kind: 'enclose', notation, body: this.#row(style, depth + 1) } });
                return;
            }
            case 'pmod':
                into.push(
                    { chars: `${SPACES.quad.text}(`, style },
                    { chars: 'mod', style: { ...style, letters: 'normal' } },
                    { chars: SPACES.normal.text, style },
                );
                this.#spliced(into, style, depth);
                into.push({ chars: ')', style });
                return;
            case 'braket': {
                this.#pos = this.#starred(this.#pos, command.stars);
                const at = this.#ketAt(command, this.#pos, 0);
                if (at === undefined) {
                    into.push({ node: this.#braket(command.open, command.close, command.split, style, depth) });
                    return;
                }
                const bra = this.#row(style, depth + 1);
                this.#pos = at;
                const ket = this.#isChar(at, '{') ? this.#row(style, depth + 1) : this.#build([], depth + 1);
                into.push({ node: barred(LANGLE, RANGLE, [bra, ket]) });
                return;
            }
            case 'expectation': {
                this.#pos = this.#starred(this.#pos, command.stars);
                const operator = this.#row(style, depth + 1);
                if (!this.#isChar(this.#pos, '{')) {
                    into.push({ node: barred(LANGLE, RANGLE, [operator]) });
                    return;
                }
                const before = this.#budget.size;
                const state = this.#row(style, depth + 1);
                into.push({ node: barred(LANGLE, RANGLE, [this.#again(state, before, depth + 1), operator, state]) });
                return;
            }
            case 'matrixElement': {
                this.#pos = this.#starred(this.#pos, command.stars);
                const parts = [this.#row(style, depth + 1), this.#row(style, depth + 1), this.#row(style, depth + 1)];
                into.push({ node: barred(LANGLE, RANGLE, parts) });
                return;
            }
            case 'outerProduct': {
                this.#pos = this.#starred(this.#pos, command.stars);
                const before = this.#budget.size;
                const ket = this.#row(style, depth + 1);
                const bra = this.#isChar(this.#pos, '{')
                    ? this.#row(style, depth + 1)
                    : this.#again(ket, before, depth + 1);
                into.push({ node: barred('|', RANGLE, [ket]) }, { node: barred(LANGLE, '|', [bra]) });
                return;
            }
            case 'left':
                into.push({ node: this.#fenced(style, depth) });
                return;
            case 'begin':
                into.push({ node: this.#environment(style, depth) });
                return;
            case 'big':
                into.push({ chars: this.#delimiter(), style });
                return;
            case 'not': {
                // \not\not slashes twice. NFC composes the slashed symbol where Unicode has it, such as ≠.
                let slashes = NOT;
                for (; this.#commandAt(this.#pos)?.kind === 'not'; this.#pos++) slashes += NOT;
                const at = this.#offset(this.#pos);
                const operator = this.#commandAt(this.#pos);
                const next = this.#pos < this.#end ? this.#tokens[this.#pos++] : undefined;
                const char =
                    operator?.kind === 'largeOperator'
                        ? operator.operator
                        : next && (next.command || !/^[{}^_&]$/.test(next.text))
                          ? charOf(next)
                          : '';
                if (char.trim() === '') throw new MathError('\\not takes a symbol', at);
                // The slash comes after the marks written after the symbol, as it does after a character's own.
                let marks = '';
                for (; this.#isMark(this.#pos); this.#pos++) marks += this.#tokens[this.#pos].text;
                into.push({ chars: char + marks + slashes, style });
                return;
            }
            case 'limits':
            case 'colorSwitch':
            case 'middle':
            case 'right':
            case 'end':
                throw this.#unexpected(this.#pos - 1);
        }
    }
}

export function readLatex(latex: string): MathRow {
    if (latex.length > MATH_LIMITS.latexLength) {
        throw new MathError(
            `An equation's LaTeX is at most ${MATH_LIMITS.latexLength} characters`,
            MATH_LIMITS.latexLength,
        );
    }
    return new LatexReader(latex).read();
}

// ── Writer ─────────────────────────────────────────────────────────────────────────────────────────────────────

// The first name the table lists for each character, accent, operator, variant and so on.
function namesOf<K>(key: (command: LatexCommand) => K | undefined): ReadonlyMap<K, string> {
    const names = new Map<K, string>();
    for (const [name, command] of LATEX_COMMANDS) {
        const found = key(command);
        if (found !== undefined && !names.has(found)) names.set(found, name);
    }
    return names;
}

const SYMBOL_NAMES = namesOf((command) => (command.kind === 'symbol' ? command.char : undefined));
const DELIMITER_NAMES = namesOf((command) =>
    command.kind === 'symbol' && command.class === 'delimiter' ? command.char : undefined,
);
const OPERATOR_NAMES = namesOf((command) => (command.kind === 'largeOperator' ? command.operator : undefined));
const ACCENT_NAMES = namesOf((command) => (command.kind === 'accent' ? command.accent : undefined));
const FONT_NAMES = namesOf((command) => (command.kind === 'font' ? command.variant : undefined));
const SPACE_NAMES = namesOf((command) => (command.kind === 'space' ? command.width : undefined));
const LINE_NAMES = namesOf((command) => (command.kind === 'line' ? command.position : undefined));
const FRACTION_NAMES = namesOf((command) =>
    command.kind === 'fraction' ? `${command.open} ${command.close} ${command.line}` : undefined,
);
const LIMIT_NAMES = namesOf((command) => (command.kind === 'limit' ? command.position : undefined));
const BRACE_NAMES = namesOf((command) => (command.kind === 'brace' ? command.char + command.position : undefined));
const ENCLOSE_NAMES = namesOf((command) => (command.kind === 'enclose' ? command.notation.join(' ') : undefined));
const ENVIRONMENT_NAMES = new Map(
    Array.from(LATEX_ENVIRONMENTS, ([name, { layout, open, close }]) => [`${layout} ${open} ${close}`, name]),
);

// Word's fence characters that LaTeX draws with its own: they read back as these.
const FENCE_TWINS: ReadonlyMap<string, string> = new Map([
    ['\u2329', '⟨'],
    ['\u232A', '⟩'],
    ['∥', '‖'],
]);

// Characters the tokenizer reads as something else; in math they are written by name, as are non-ASCII ones.
const SPECIAL: ReadonlySet<string> = new Set("\\{}%&#$_^~'");

// A control word runs on into a letter after it, and in KaTeX into an @, so a space keeps them apart.
function joined(parts: readonly string[]): string {
    let latex = '';
    let last = '';
    for (const part of parts) {
        if (part === '') continue;
        latex += /\\[A-Za-z]+$/.test(last) && /^[A-Za-z@]/.test(part) ? ` ${part}` : part;
        last = part;
    }
    return latex;
}

function writeChar(char: string): string {
    if (char === PRIME) return "'";
    if (char === MINUS) return '-';
    const operator = OPERATOR_NAMES.get(char);
    // Alone, a large-operator command would take the next atom as its body.
    if (operator) return `{\\${operator}}`;
    const name = SPECIAL.has(char) || char > '~' ? SYMBOL_NAMES.get(char) : undefined;
    if (name !== undefined) return `\\${name}`;
    const negated = negation(char);
    if (negated !== undefined) return negated;
    const [base] = char;
    // Math mode has no command KaTeX and MathJax both read for these: text draws them, without their marks.
    if (base === '^' || base === '~') return `\\text{${TEXT_ESCAPES[base]}}`;
    // A character and the marks no command draws.
    return [...char].length > 1 ? joined([...char].map(writeChar)) : char;
}

// What \not takes: one symbol, a slashed one too, then the marks after it.
const SLASHABLE = /^(?:\\not ?)*(?:\\[A-Za-z]+|\\[^A-Za-z]|[^\\{}^_&'~])\p{M}*$/u;

// A slashed symbol without a command of its own, such as ≢, is \not before the symbol, as TeX draws it. \not puts its
// slash last, after the symbol's marks, so a slash before another mark stays as it is, and so does a symbol NFC
// doesn't compose back from its slash, such as U+2ADC.
function negation(char: string): string | undefined {
    const decomposed = char.normalize('NFD');
    if (!decomposed.endsWith(NOT)) return undefined;
    const base = decomposed.slice(0, -1).normalize('NFC');
    if ((base + NOT).normalize('NFC') !== char) return undefined;
    const written = writeChar(base);
    if (SLASHABLE.test(written)) return joined(['\\not', written]);
    // A large operator or a prime by its command, not as writeChar sets it apart; an apostrophe reads back as a prime.
    const [head = '', ...marks] = base;
    const name = head === PRIME || head === "'" ? 'prime' : OPERATOR_NAMES.get(head);
    const symbol = name && joined([`\\${name}`, ...marks]);
    return symbol && SLASHABLE.test(symbol) ? joined(['\\not', symbol]) : undefined;
}

// The font a token needs beyond the default (math's, or upright in \operatorname); undefined if none.
function fontOf(node: MathToken, upright: boolean): MathVariant | undefined {
    if (node.kind !== 'identifier') return node.variant;
    if (clusters(node.text).length > 1) return upright ? undefined : 'normal';
    const variant = node.variant ?? defaultVariant(node.kind, node.text);
    return variant === (upright ? 'normal' : defaultVariant(node.kind, node.text)) ? undefined : variant;
}

const colored = (color: string | undefined, latex: string) => {
    const hex = hexColor(color);
    return hex ? `\\textcolor{${hex}}{${latex}}` : latex;
};

function writeToken(node: MathToken, upright: boolean): string {
    // In \operatorname a - between letters is a hyphen, so the minus sign is written as itself there.
    const text = upright && node.text === MINUS ? MINUS : joined(clusters(node.text).map(writeChar));
    // A word with a hyphen keeps it only in \operatorname, braced so it takes no body.
    if (!upright && node.kind === 'identifier' && node.text.includes('-'))
        return colored(node.color, `{\\operatorname{${text}}}`);
    const font = fontOf(node, upright);
    return colored(node.color, font ? `\\${FONT_NAMES.get(font)}{${text}}` : text);
}

// A brace with a command and a label over or under it: \overbrace{…}^{…}.
function isLabelledBrace(node: Extract<MathNode, { kind: 'limit' }>): boolean {
    const [brace] = node.base;
    return (
        node.base.length === 1 &&
        node.limit.length > 0 &&
        brace.kind === 'brace' &&
        BRACE_NAMES.has(brace.char + brace.position)
    );
}

// TeX puts a prime after a script on that script's base: a double superscript, or a prime over a subscript.
function endsInScript(node: MathNode | undefined): boolean {
    return (node?.kind === 'scripts' && !node.pre) || (node?.kind === 'limit' && isLabelledBrace(node));
}

const writeRow = (row: MathRow, upright: boolean): string =>
    joined(
        row.map((node, index) => {
            const latex = writeNode(node, upright);
            return latex.startsWith("'") && endsInScript(row[index - 1]) ? `{}${latex}` : latex;
        }),
    );

// Whether scripts can follow a node's LaTeX without braces around it.
function isAtom(node: MathNode, upright: boolean): boolean {
    switch (node.kind) {
        case 'identifier':
        case 'number':
        case 'operator':
            return [...node.text].length === 1 || node.color !== undefined || fontOf(node, upright) !== undefined;
        case 'limit':
            return !isLabelledBrace(node);
        case 'scripts':
        case 'nary':
        case 'function':
        case 'brace':
            return false;
        case 'fenced':
            return delimiters(node) !== undefined;
        case 'text':
        case 'space':
        case 'fraction':
        case 'radical':
        case 'accent':
        case 'line':
        case 'enclose':
        case 'table':
            return true;
    }
}

const isPrime = (node: MathNode) => node.kind === 'operator' && node.text === PRIME && !node.variant && !node.color;

function writeScripts(node: { sub?: MathRow; sup?: MathRow }, upright: boolean): string {
    const sub = node.sub ? `_{${writeRow(node.sub, upright)}}` : '';
    if (!node.sup) return sub;
    // TeX raises a ' as a superscript: in a superscript of primes alone it would rise twice.
    const sup = node.sup.every(isPrime) ? '\\prime'.repeat(node.sup.length) : writeRow(node.sup, upright);
    return `${sub}^{${sup}}`;
}

// A function name as its command where the table has one, with a limit or scripts after it.
function functionOf(row: MathRow): { name: string; limits: boolean } | undefined {
    const [node] = row;
    if (row.length !== 1 || node.kind !== 'identifier' || node.variant || node.color) return undefined;
    const command = LATEX_COMMANDS.get(node.text);
    return command?.kind === 'function' ? { name: node.text, limits: command.limits } : undefined;
}

function writeName(name: MathRow, upright: boolean): string {
    const [head] = name;
    const plain = functionOf(name);
    if (plain) return `\\${plain.name}`;
    if (name.length === 1 && head.kind === 'limit') {
        const limited = functionOf(head.base);
        const script = head.position === 'over' ? '^' : '_';
        if (limited?.limits && head.limit.length > 0)
            return `\\${limited.name}${script}{${writeRow(head.limit, upright)}}`;
    }
    if (name.length === 1 && head.kind === 'scripts' && !head.pre) {
        const scripted = functionOf(head.base);
        if (scripted && !scripted.limits) return `\\${scripted.name}${writeScripts(head, upright)}`;
    }
    return `\\operatorname{${writeRow(name, true)}}`;
}

// '' is no fence; undefined is a character no command draws.
function writeDelimiter(char: string): string | undefined {
    if (char === '') return '.';
    const twin = FENCE_TWINS.get(char) ?? char;
    if (DELIMITER_CHARS.has(twin)) return twin;
    const name = DELIMITER_NAMES.get(twin);
    return name === undefined ? undefined : `\\${name}`;
}

// A fenced row's \left, \right and \middle delimiters; undefined where no command draws one of its characters.
function delimiters(node: Extract<MathNode, { kind: 'fenced' }>): [string, string, string] | undefined {
    const open = writeDelimiter(node.open);
    const close = writeDelimiter(node.close);
    const separator = node.parts.length > 1 ? writeDelimiter(node.separator) : '';
    return open === undefined || close === undefined || separator === undefined ? undefined : [open, close, separator];
}

const interleave = (parts: string[], between: string[]) =>
    parts.flatMap((part, index) => (index === 0 ? [part] : [...between, part]));

function writeTable(node: Extract<MathNode, { kind: 'table' }>, environment: string, upright: boolean): string {
    const rows = node.rows.map((cells, index) => {
        const row = cells.map((cell) => writeRow(cell, upright)).join(' & ');
        // Nothing after the last \\ reads as no row.
        return index > 0 && row === '' ? '{}' : row;
    });
    return `\\begin{${environment}}${rows.join(' \\\\ ')}\\end{${environment}}`;
}

// A lone combining mark is no fence: written as itself, it would join the character after it.
const fenceOf = (char: string) => (MARK.test(char) ? '' : char);

function writeFenced(fenced: Extract<MathNode, { kind: 'fenced' }>, upright: boolean): string {
    const node = {
        ...fenced,
        open: fenceOf(fenced.open),
        close: fenceOf(fenced.close),
        separator: fenceOf(fenced.separator),
    };
    const [part] = node.parts;
    const [only] = part;
    // A table or fraction in fences, as pmatrix and \binom draw them; without fences it is a fenced row of its own.
    if (node.parts.length === 1 && part.length === 1 && node.open + node.close !== '') {
        if (only.kind === 'table') {
            const environment = ENVIRONMENT_NAMES.get(`${only.layout} ${node.open} ${node.close}`);
            if (environment) return writeTable(only, environment, upright);
        }
        if (only.kind === 'fraction') {
            const name = FRACTION_NAMES.get(`${node.open} ${node.close} ${only.line}`);
            if (name) return `\\${name}{${writeRow(only.numerator, upright)}}{${writeRow(only.denominator, upright)}}`;
        }
    }
    const parts = node.parts.map((row) => writeRow(row, upright));
    const drawn = delimiters(node);
    if (!drawn) {
        // Its characters as they are: no atom, so scripts brace them as a base.
        const plain = interleave(parts, [writeChar(node.separator)]);
        return joined([writeChar(node.open), ...plain, writeChar(node.close)]);
    }
    const [open, close, separator] = drawn;
    return joined(['\\left', open, ...interleave(parts, ['\\middle', separator]), '\\right', close]);
}

function writeNode(node: MathNode, upright: boolean): string {
    switch (node.kind) {
        case 'identifier':
        case 'number':
        case 'operator':
            return writeToken(node, upright);
        case 'text': {
            // In text TeX reads a run of spaces as one, so a run is written as control spaces.
            const text = node.text.replace(/ {2,}|[^ ]/gu, (match) =>
                match.startsWith(' ') ? '\\ '.repeat(match.length) : (TEXT_ESCAPES[match] ?? match),
            );
            return colored(node.color, `\\text{${text}}`);
        }
        case 'space':
            return `\\${SPACE_NAMES.get(node.width)}`;
        case 'fraction': {
            const parts = `{${writeRow(node.numerator, upright)}}{${writeRow(node.denominator, upright)}}`;
            // LaTeX has no skewed fraction: it is written upright.
            return node.line === 'none' ? `\\genfrac{}{}{0pt}{}${parts}` : `\\frac${parts}`;
        }
        case 'scripts': {
            if (node.pre) {
                const sup = node.sup ? writeRow(node.sup, upright) : '';
                const sub = node.sub ? writeRow(node.sub, upright) : '';
                return `\\prescript{${sup}}{${sub}}{${writeRow(node.base, upright)}}`;
            }
            const base = writeRow(node.base, upright);
            const atom = node.base.length === 1 && isAtom(node.base[0], upright);
            return `${atom ? base : `{${base}}`}${writeScripts(node, upright)}`;
        }
        case 'radical': {
            const degree = node.degree ? writeRow(node.degree, upright) : undefined;
            // TeX ends the optional argument at the first ] outside braces; KaTeX takes a leading group as all of it.
            const braced = degree?.includes(']') || degree?.startsWith('{');
            const bracket = degree === undefined ? '' : braced ? `[{${degree}}]` : `[${degree}]`;
            return `\\sqrt${bracket}{${writeRow(node.body, upright)}}`;
        }
        case 'nary': {
            const name = OPERATOR_NAMES.get(node.operator);
            const scripted = node.sub !== undefined || node.sup !== undefined;
            const limits =
                name && scripted && node.limits !== naryLimits(node.operator)
                    ? node.limits === 'under'
                        ? '\\limits'
                        : '\\nolimits'
                    : '';
            const operator = name ? `\\${name}` : writeChar(node.operator);
            return `${operator}${limits}${writeScripts(node, upright)}{${writeRow(node.body, upright)}}`;
        }
        case 'fenced':
            return writeFenced(node, upright);
        case 'function':
            return `${writeName(node.name, upright)}{${writeRow(node.body, upright)}}`;
        case 'accent': {
            const name = ACCENT_NAMES.get(node.accent);
            const body = writeRow(node.body, upright);
            const spacing = ACCENTS.get(node.accent) ?? node.accent;
            return name ? `\\${name}{${body}}` : `\\overset{${writeChar(spacing)}}{${body}}`;
        }
        case 'line':
            return `\\${LINE_NAMES.get(node.position)}{${writeRow(node.body, upright)}}`;
        case 'brace': {
            const name = BRACE_NAMES.get(node.char + node.position);
            const body = writeRow(node.body, upright);
            return name
                ? `\\${name}{${body}}`
                : `\\${LIMIT_NAMES.get(node.position)}{${writeChar(node.char)}}{${body}}`;
        }
        case 'limit': {
            const limit = writeRow(node.limit, upright);
            if (isLabelledBrace(node)) {
                return `${writeRow(node.base, upright)}${node.position === 'over' ? '^' : '_'}{${limit}}`;
            }
            return `\\${LIMIT_NAMES.get(node.position)}{${limit}}{${writeRow(node.base, upright)}}`;
        }
        case 'enclose': {
            const name = ENCLOSE_NAMES.get(node.notation.join(' '));
            const body = writeRow(node.body, upright);
            return name ? `\\${name}{${body}}` : `\\enclose{${node.notation.join(',')}}{${body}}`;
        }
        case 'table':
            return writeTable(node, BARE_ENVIRONMENTS[node.layout], upright);
    }
}

export function writeLatex(row: MathRow): string {
    return checkedXml(writeRow(row, false));
}
