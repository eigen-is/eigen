// The looks of one workbook, each held once. A look is the format keys a cell wears, such as bold, a number format, a
// fill or a border side, and a sheet's bands name it by the integer id it gets here: equal looks get one id whatever
// order their keys came in, and id 0 is the plain look. The workbook interns a look before it writes it to a sheet's
// bands, reads it back for a cell, and sweeps the table once most of its looks are worn by no cell.

import type { CellAttrs } from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';

export class LookTable {
    private looks: Readonly<CellAttrs>[] = [Object.freeze({})];
    // A look's id under its keys and values as JSON, the keys in LOOK_KEYS order.
    private ids = new Map<string, number>([['{}', 0]]);

    // The highest id given out, plus one.
    public get size(): number {
        return this.looks.length;
    }

    public look(id: number): Readonly<CellAttrs> {
        return this.looks[id];
    }

    // Values are kept as given: two spellings of one color are two looks.
    public intern(look: CellAttrs): number {
        const canonical: CellAttrs = {};
        for (const key of LOOK_KEYS) {
            const value = look[key];
            if (value === undefined) continue;
            const kept = typeof value === 'object' ? Object.freeze({ style: value.style, color: value.color }) : value;
            Object.assign(canonical, { [key]: kept });
        }
        const key = JSON.stringify(canonical);
        const known = this.ids.get(key);
        if (known !== undefined) return known;
        this.ids.set(key, this.looks.length);
        this.looks.push(Object.freeze(canonical));
        return this.looks.length - 1;
    }

    // Forgets every look but plain and those whose id is in `worn`, and numbers the rest anew in their old order.
    // Returns the new id of each old id, -1 for a forgotten look: whoever holds an id must map it.
    public sweep(worn: ReadonlySet<number>): Int32Array {
        const moved = new Int32Array(this.looks.length).fill(-1);
        const looks: Readonly<CellAttrs>[] = [];
        const ids = new Map<string, number>();
        for (const [key, id] of this.ids) {
            if (id !== 0 && !worn.has(id)) continue;
            moved[id] = looks.length;
            ids.set(key, looks.length);
            looks.push(this.looks[id]);
        }
        this.looks = looks;
        this.ids = ids;
        return moved;
    }
}
