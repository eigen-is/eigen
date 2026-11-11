// The string table of one workbook: every distinct text of a cell once, under an integer id that the cell holds.
// Each text also knows the id of its upper-cased comparison form, so a lookup or a criterion tells two texts that
// differ only by case to be equal by comparing two integers.

import { textKey } from '../values/text-order';

export class StringTable {
    private readonly ids = new Map<string, number>();
    private readonly texts: string[] = [];
    private readonly uppers: number[] = [];

    public intern(text: string): number {
        const known = this.ids.get(text);
        if (known !== undefined) return known;
        const id = this.texts.length;
        this.ids.set(text, id);
        this.texts.push(text);
        this.uppers.push(id);
        const key = textKey(text);
        if (key !== text) this.uppers[id] = this.intern(key);
        return id;
    }

    public text(id: number): string {
        return this.texts[id];
    }

    public upper(id: number): number {
        return this.uppers[id];
    }
}
