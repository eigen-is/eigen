// F4 reference cycling for formula editing. Given a formula's plain text and the
// caret (or selection), find the cell/range reference the caret is inside or
// immediately adjacent to and cycle its absolute/relative `$` flags, matching
// Excel/Google Sheets: A1 → $A$1 → A$1 → $A1 → A1.
//
// Pure — no Context, no DOM. Reuses the engine's ref primitives (`iscelldata`
// recognizes a token as a ref; `detectAbsolute` reads a leg's [row$, col$] flags)
// rather than re-deriving a ref grammar.
import { detectAbsolute } from './formula-shift';
import { iscelldata } from './formula-utils';

export type ReferenceCycleResult = {
    text: string;
    selectionStart: number;
    selectionEnd: number;
};

type RefSpan = { start: number; end: number; value: string };

// Chars that can appear inside a reference token: column letters, row digits,
// `$` anchors, the `:` range operator, and the `!` sheet separator. Quoted sheet
// names (`'My Sheet'!A1`) are consumed separately so their spaces/specials stay
// glued to the token.
const REF_WORD = /[A-Za-z0-9$:!]/;

// The four cycle states indexed by press order, expressed as [colAbsolute, rowAbsolute]:
//   0: A1 (relative)  1: $A$1 (both)  2: A$1 (row-only)  3: $A1 (col-only)
const CYCLE_STATES: ReadonlyArray<readonly [boolean, boolean]> = [
    [false, false],
    [true, true],
    [false, true],
    [true, false],
];

function stateIndex(colAbs: boolean, rowAbs: boolean): number {
    if (!colAbs && !rowAbs) return 0;
    if (colAbs && rowAbs) return 1;
    if (!colAbs && rowAbs) return 2;
    return 3;
}

// Rebuild a single ref leg (e.g. "A1", "$A", "3") with the requested $ flags. A
// flag on a missing axis (no letters, or no digits) is dropped — that is what
// collapses whole-column ("A:C") and whole-row ("1:3") refs to a 2-state cycle.
function formatLeg(leg: string, colAbs: boolean, rowAbs: boolean): string {
    const letters = leg.replace(/[^A-Za-z]/g, '');
    const digits = leg.replace(/[^0-9]/g, '');
    const col = letters ? (colAbs ? `$${letters}` : letters) : '';
    const row = digits ? (rowAbs ? `$${digits}` : digits) : '';
    return col + row;
}

// Cycle every leg of a ref to the next $ state. The first endpoint's current state
// selects the next state; it is then applied to all legs (Excel's mixed-range rule).
function cycleRef(ref: string): string {
    const bang = ref.lastIndexOf('!');
    const prefix = bang >= 0 ? ref.slice(0, bang + 1) : '';
    const body = bang >= 0 ? ref.slice(bang + 1) : ref;

    const legs = body.split(':');
    const [rowAbs, colAbs] = detectAbsolute(legs[0]);
    const [nextColAbs, nextRowAbs] = CYCLE_STATES[(stateIndex(colAbs, rowAbs) + 1) % 4];

    return prefix + legs.map((leg) => formatLeg(leg, nextColAbs, nextRowAbs)).join(':');
}

// Split the formula into maximal reference-candidate runs with their plain-text
// offsets. Non-ref runs (function names, numbers) are kept too so the caret test
// can reject them.
function findRefSpans(text: string): RefSpan[] {
    const spans: RefSpan[] = [];
    const n = text.length;
    let i = 0;

    while (i < n) {
        const c = text[i];
        if (c !== "'" && !REF_WORD.test(c)) {
            i += 1;
            continue;
        }
        const start = i;
        while (i < n) {
            if (text[i] === "'") {
                i += 1;
                while (i < n) {
                    if (text[i] === "'") {
                        if (text[i + 1] === "'") {
                            i += 2; // doubled '' is an escaped quote inside the name
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            } else if (REF_WORD.test(text[i])) {
                i += 1;
            } else {
                break;
            }
        }
        spans.push({ start, end: i, value: text.slice(start, i) });
    }

    return spans;
}

function findRefAtCaret(text: string, caretStart: number, caretEnd: number): RefSpan | null {
    const collapsed = caretStart === caretEnd;
    for (const span of findRefSpans(text)) {
        // A span immediately followed by '(' is a function call, not a reference
        // (LOG10, ATAN2, IMLOG2 all satisfy iscelldata as A1-style refs) — skip it.
        if (text[span.end] === '(') continue;
        // A collapsed caret cycles the ref it sits inside or is immediately adjacent
        // to (touching either edge). A selection needs a real overlap so a caret that
        // merely clips the operator before a ref doesn't grab the wrong one.
        const touches = collapsed
            ? span.start <= caretStart && caretStart <= span.end
            : span.start < caretEnd && caretStart < span.end;
        if (touches && iscelldata(span.value)) return span;
    }
    return null;
}

export function cycleReferenceAtCaret(text: string, caretStart: number, caretEnd: number): ReferenceCycleResult | null {
    if (text[0] !== '=') return null;

    const span = findRefAtCaret(text, caretStart, caretEnd);
    if (!span) return null;

    const newRef = cycleRef(span.value);
    return {
        text: text.slice(0, span.start) + newRef + text.slice(span.end),
        selectionStart: span.start,
        selectionEnd: span.start + newRef.length,
    };
}
