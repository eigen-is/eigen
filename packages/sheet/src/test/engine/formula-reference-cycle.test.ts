import { describe, expect, test } from 'bun:test';
import { cycleReferenceAtCaret } from '../../engine/formula-reference-cycle';

// Helper: cycle once with a collapsed caret placed at `caret` (plain-text offset).
function cycle(text: string, caret: number) {
    return cycleReferenceAtCaret(text, caret, caret);
}

// Helper: drive N successive F4 presses, feeding each result's selection back in
// (mirrors the real editor keeping the reference selected between presses).
function cycleChain(text: string, caret: number, presses: number): string[] {
    const out: string[] = [];
    let cur = cycleReferenceAtCaret(text, caret, caret);
    for (let i = 0; i < presses && cur; i += 1) {
        out.push(cur.text);
        cur = cycleReferenceAtCaret(cur.text, cur.selectionStart, cur.selectionEnd);
    }
    return out;
}

describe('engine/formula-reference-cycle — single-cell cycle order', () => {
    test('canonical order from a relative start with wrap-around', () => {
        // A1 → $A$1 → A$1 → $A1 → A1
        expect(cycleChain('=A1', 2, 5)).toEqual(['=$A$1', '=A$1', '=$A1', '=A1', '=$A$1']);
    });

    test('one press from each state', () => {
        expect(cycle('=A1', 2)!.text).toBe('=$A$1');
        expect(cycle('=$A$1', 3)!.text).toBe('=A$1');
        expect(cycle('=A$1', 2)!.text).toBe('=$A1');
        expect(cycle('=$A1', 3)!.text).toBe('=A1');
    });

    test('caret at the left edge, middle, and right edge of the ref all cycle it', () => {
        // "=A1": ref A1 occupies plain-text offsets [1,3)
        expect(cycle('=A1', 1)!.text).toBe('=$A$1'); // just after '='
        expect(cycle('=A1', 2)!.text).toBe('=$A$1'); // between A and 1
        expect(cycle('=A1', 3)!.text).toBe('=$A$1'); // at the very end
    });

    test('returns a selection covering the cycled reference', () => {
        const r = cycle('=A1', 2)!;
        expect(r.text).toBe('=$A$1');
        expect(r.selectionStart).toBe(1);
        expect(r.selectionEnd).toBe(5); // covers "$A$1"
    });

    test('preserves the original column-letter case', () => {
        expect(cycle('=a1', 2)!.text).toBe('=$a$1');
    });
});

describe('engine/formula-reference-cycle — ranges cycle both endpoints together', () => {
    test('relative range walks all four states', () => {
        expect(cycleChain('=A1:B2', 2, 4)).toEqual(['=$A$1:$B$2', '=A$1:B$2', '=$A1:$B2', '=A1:B2']);
    });

    test('caret anywhere inside the range (incl. the colon) cycles the whole range', () => {
        expect(cycle('=A1:B2', 2)!.text).toBe('=$A$1:$B$2'); // on the first endpoint
        expect(cycle('=A1:B2', 4)!.text).toBe('=$A$1:$B$2'); // on the colon
        expect(cycle('=A1:B2', 6)!.text).toBe('=$A$1:$B$2'); // on the second endpoint
    });

    test('mixed-$ range uses the FIRST endpoint state and applies it to both', () => {
        // First endpoint $A$1 is fully-absolute (index 1) → next state is row-only-abs,
        // applied to BOTH legs regardless of the second endpoint's original state.
        expect(cycle('=$A$1:B2', 3)!.text).toBe('=A$1:B$2');
        // First endpoint $A1 is col-only-abs (index 3) → next is relative, applied to both.
        expect(cycle('=$A1:B$2', 3)!.text).toBe('=A1:B2');
    });
});

describe('engine/formula-reference-cycle — whole-column / whole-row refs', () => {
    test('column-only range toggles the column $ only (2-state cycle)', () => {
        expect(cycleChain('=A:C', 2, 3)).toEqual(['=$A:$C', '=A:C', '=$A:$C']);
    });

    test('row-only range toggles the row $ only (2-state cycle)', () => {
        expect(cycleChain('=1:3', 2, 3)).toEqual(['=$1:$3', '=1:3', '=$1:$3']);
    });
});

describe('engine/formula-reference-cycle — sheet-qualified refs cycle only the A1 part', () => {
    test('simple sheet name', () => {
        expect(cycle('=Sheet1!A1', 8)!.text).toBe('=Sheet1!$A$1');
    });

    test('quoted sheet name with a space', () => {
        expect(cycle("='My Sheet'!A1", 12)!.text).toBe("='My Sheet'!$A$1");
    });

    test('sheet-qualified range keeps the prefix and cycles both endpoints', () => {
        expect(cycle('=Sheet1!A1:B2', 9)!.text).toBe('=Sheet1!$A$1:$B$2');
    });
});

describe('engine/formula-reference-cycle — refs inside a longer formula', () => {
    test('caret on a trailing ref only touches that ref', () => {
        // "=SUM(A1:B2)+C3": C3 at [12,14)
        expect(cycle('=SUM(A1:B2)+C3', 13)!.text).toBe('=SUM(A1:B2)+$C$3');
    });

    test('caret on the inner range only touches that range', () => {
        expect(cycle('=SUM(A1:B2)+C3', 7)!.text).toBe('=SUM($A$1:$B$2)+C3');
    });

    test('multiple refs adjacent to operators cycle independently', () => {
        expect(cycle('=A1+B2', 2)!.text).toBe('=$A$1+B2');
        expect(cycle('=A1+B2', 5)!.text).toBe('=A1+$B$2');
    });
});

describe('engine/formula-reference-cycle — no-op cases return null', () => {
    test('caret on a function name', () => {
        expect(cycle('=SUM(A1)', 2)).toBeNull();
    });

    test('caret on a numeric literal', () => {
        // "=A1+123": 123 at [4,7)
        expect(cycle('=A1+123', 5)).toBeNull();
    });

    test('caret inside a function name that parses as a ref', () => {
        // LOG10 / ATAN2 / IMLOG2 all satisfy iscelldata, but a token immediately
        // followed by '(' is a function call, not a reference — never cycle it.
        expect(cycle('=LOG10(8)', 3)).toBeNull();
        expect(cycle('=ATAN2(1,1)', 3)).toBeNull();
        expect(cycle('=IMLOG2(2)', 4)).toBeNull();
    });

    test('a real ref argument to such a function still cycles', () => {
        // "=LOG10(A1)": A1 at [7,9); the function name is skipped, the arg is not.
        expect(cycle('=LOG10(A1)', 8)!.text).toBe('=LOG10($A$1)');
    });

    test('text that is not a formula', () => {
        expect(cycle('A1', 1)).toBeNull();
        expect(cycle('hello', 3)).toBeNull();
        expect(cycle('', 0)).toBeNull();
    });

    test('caret before the leading equals', () => {
        expect(cycle('=A1', 0)).toBeNull();
    });

    test('caret on an operator between two refs', () => {
        // "=A1<>B2": caret at offset 4 sits between '<' and '>', touching neither ref
        expect(cycle('=A1<>B2', 4)).toBeNull();
    });
});

describe('engine/formula-reference-cycle — selection input', () => {
    test('a selection covering the ref cycles it and re-selects it', () => {
        // Select "B2" in "=A1+B2" (offsets 4..6)
        const r = cycleReferenceAtCaret('=A1+B2', 4, 6)!;
        expect(r.text).toBe('=A1+$B$2');
        expect(r.selectionStart).toBe(4);
        expect(r.selectionEnd).toBe(8);
    });

    test('a selection that only clips the operator picks the overlapped ref', () => {
        // Select "+B2" (offsets 3..6) — the '+' boundary must not grab A1
        const r = cycleReferenceAtCaret('=A1+B2', 3, 6)!;
        expect(r.text).toBe('=A1+$B$2');
    });
});
