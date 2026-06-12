import type { BorderInfo, BorderSide } from '@workspace/lib/sheets';

export type CellBorderSides = {
    l?: BorderSide | null;
    r?: BorderSide | null;
    t?: BorderSide | null;
    b?: BorderSide | null;
};

// Resolves `config.borderInfo` (cell + toolbar range entries, in array order) into
// per-cell border sides keyed `${row}_${col}`. Mirrors the per-cell semantics of the
// editor's render-time compute (packages/sheet/src/state/modules/border.ts) for the
// supported borderTypes, minus its render-only concerns (hidden-row skips, merge
// bleed onto neighbour entries). 'border-slash' has no xlsx equivalent and is skipped.
export function expandBorderInfo(borderInfo: BorderInfo[]): Map<string, CellBorderSides> {
    const cells = new Map<string, CellBorderSides>();
    const at = (r: number, c: number): CellBorderSides => {
        const key = `${r}_${c}`;
        let sides = cells.get(key);
        if (!sides) {
            sides = {};
            cells.set(key, sides);
        }
        return sides;
    };
    const clearSide = (r: number, c: number, side: keyof CellBorderSides) => {
        const sides = cells.get(`${r}_${c}`);
        if (sides) delete sides[side];
    };

    for (const entry of borderInfo) {
        if (entry.rangeType === 'cell') {
            const { row_index, col_index, l, r, t, b } = entry.value;
            // All sides nil means the entry erases the cell's borders entirely.
            if (l == null && r == null && t == null && b == null) {
                cells.delete(`${row_index}_${col_index}`);
                continue;
            }
            // A side-bearing entry re-specifies every side: nil sides are cleared.
            const sides = at(row_index, col_index);
            sides.l = l ?? null;
            sides.r = r ?? null;
            sides.t = t ?? null;
            sides.b = b ?? null;
            continue;
        }

        const { borderType } = entry;
        if (borderType === 'border-slash') continue;
        const side: BorderSide = { style: Number(entry.style), color: entry.color };

        for (const range of entry.range) {
            const [r1, r2] = range.row;
            const [c1, c2] = range.column;
            for (let r = r1; r <= r2; r += 1) {
                for (let c = c1; c <= c2; c += 1) {
                    switch (borderType) {
                        case 'border-all':
                            Object.assign(at(r, c), { l: side, r: side, t: side, b: side });
                            break;
                        case 'border-outside':
                            if (r === r1) at(r, c).t = side;
                            if (r === r2) at(r, c).b = side;
                            if (c === c1) at(r, c).l = side;
                            if (c === c2) at(r, c).r = side;
                            break;
                        case 'border-inside':
                            // Inner edges expressed once, as the top/left side of the
                            // cell below/right of the edge.
                            if (r > r1) at(r, c).t = side;
                            if (c > c1) at(r, c).l = side;
                            break;
                        case 'border-horizontal':
                            // First-branch-wins per row, like the editor compute: the
                            // first row takes the edge below it, the last row the edge
                            // above, inner rows both — so a single-row range still
                            // exports its bottom edge. For multi-row ranges the edges
                            // are identical to a strict inner-edge expansion.
                            if (r === r1) at(r, c).b = side;
                            else if (r === r2) at(r, c).t = side;
                            else Object.assign(at(r, c), { t: side, b: side });
                            break;
                        case 'border-vertical':
                            // Column mirror of border-horizontal: first column takes
                            // the edge to its right, last column the edge to its left.
                            if (c === c1) at(r, c).r = side;
                            else if (c === c2) at(r, c).l = side;
                            else Object.assign(at(r, c), { l: side, r: side });
                            break;
                        case 'border-left':
                            if (c === c1) at(r, c).l = side;
                            break;
                        case 'border-right':
                            if (c === c2) at(r, c).r = side;
                            break;
                        case 'border-top':
                            if (r === r1) at(r, c).t = side;
                            break;
                        case 'border-bottom':
                            if (r === r2) at(r, c).b = side;
                            break;
                        case 'border-none':
                            cells.delete(`${r}_${c}`);
                            // The editor also erases the facing sides of adjacent
                            // outside cells, so the shared edges go fully blank.
                            if (r === r1) clearSide(r1 - 1, c, 'b');
                            if (r === r2) clearSide(r2 + 1, c, 't');
                            if (c === c1) clearSide(r, c1 - 1, 'r');
                            if (c === c2) clearSide(r, c2 + 1, 'l');
                            break;
                    }
                }
            }
        }
    }
    return cells;
}
