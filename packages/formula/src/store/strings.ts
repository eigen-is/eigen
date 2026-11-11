// The string table of one workbook: every distinct text of a cell once, under an integer id that the cell holds.
// Each text also knows the id of its upper-cased comparison form, so a lookup or a criterion tells two texts that
// differ only by case to be equal by comparing two integers. The number a text reads as, which an equality
// criterion asks of every text cell it meets, is worked out once per text.

import { parseNumber } from '../values/parse-number';
import { textKey } from '../values/text-order';

export class StringTable {
    private readonly ids = new Map<string, number>();
    private readonly texts: string[] = [];
    private readonly uppers: number[] = [];
    // Per id, once asked: the number the text reads as, or null for a text that is none.
    private readonly numbers: (number | null)[] = [];

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

    // The id of a text some cell holds or held, and -1 for any other text.
    public find(text: string): number {
        return this.ids.get(text) ?? -1;
    }

    public text(id: number): string {
        return this.texts[id];
    }

    public upper(id: number): number {
        return this.uppers[id];
    }

    public number(id: number): number | null {
        let number = this.numbers[id];
        if (number === undefined) {
            number = parseNumber(this.texts[id]) ?? null;
            this.numbers[id] = number;
        }
        return number;
    }
}
