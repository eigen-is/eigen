// The string table of one workbook: every distinct text of a cell once, under an integer id that the cell holds.
// Each text also has the id of its upper-cased comparison form, its key, so a lookup or a criterion tells two texts
// that differ only by case to be equal by comparing two integers. Keys are made when one is first asked for, so a
// workbook whose texts are never compared makes none. The number a text reads as is worked out once per text.

import { parseNumber } from '../values/parse-number';
import { textKey } from '../values/text-order';

export class StringTable {
    private readonly ids = new Map<string, number>();
    private readonly texts: string[] = [];
    // The id of each text's key, for the texts that have one: all of them up to this list's length.
    private readonly uppers: number[] = [];
    // Per id, once asked: the number the text reads as, or null for a text that is none.
    private readonly numbers: (number | null)[] = [];

    public intern(text: string): number {
        const known = this.ids.get(text);
        if (known !== undefined) return known;
        this.ids.set(text, this.texts.length);
        return this.texts.push(text) - 1;
    }

    // The id of a text some cell holds or held, or that is the key of one, and -1 for any other text.
    public find(text: string): number {
        this.makeKeys();
        return this.ids.get(text) ?? -1;
    }

    public text(id: number): string {
        return this.texts[id];
    }

    public upper(id: number): number {
        this.makeKeys();
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

    // A key joins the texts when no cell held it, and the loop reaches it there: it is its own key.
    private makeKeys(): void {
        for (let id = this.uppers.length; id < this.texts.length; id += 1) {
            const text = this.texts[id];
            const key = textKey(text);
            this.uppers.push(key === text ? id : this.intern(key));
        }
    }
}
