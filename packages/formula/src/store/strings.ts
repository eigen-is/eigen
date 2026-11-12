// The string table of one workbook: every distinct text of a cell once, under an integer id the cell holds, with
// the id of its upper-cased comparison key, so texts that differ only by case compare as two integers. A pass that
// begins with the table past a floor and at twice the characters it had after its last sweep or load, or with a
// sheet removed, forgets every text that no cell holds and that is no key of one a cell holds: a later text takes
// its id. So only the `ref` plane of a sheet in the workbook holds an id, or a local for one call.

import { parseNumber } from '../values/parse-number';
import { textKey } from '../values/text-order';

// What a text weighs beside its characters, in characters: about what the table keeps for it.
const SLOT = 16;

export class StringTable {
    private readonly ids = new Map<string, number>();
    private readonly texts: string[] = [];
    // Per id, the id of the text's comparison key, or -1 for a forgotten text.
    private readonly uppers: number[] = [];
    // Per id, once asked: the number the text reads as, or null for a text that is none.
    private readonly numbers: (number | null | undefined)[] = [];
    // The ids of the forgotten texts, each for the next new text.
    private readonly free: number[] = [];
    // The characters of the texts the table holds, and SLOT for each.
    public weight = 0;

    // The highest id given out so far, plus one.
    public get size(): number {
        return this.texts.length;
    }

    public intern(text: string): number {
        const known = this.ids.get(text);
        if (known !== undefined) return known;
        const id = this.free.pop() ?? this.texts.length;
        this.ids.set(text, id);
        this.texts[id] = text;
        this.uppers[id] = id;
        this.weight += text.length + SLOT;
        const key = textKey(text);
        if (key !== text) this.uppers[id] = this.intern(key);
        return id;
    }

    // Forgets every text whose id is not set in `held`, which says for each id whether a cell holds it, and that is
    // not the comparison key of one that is. The id of a text that stays does not change.
    public keep(held: Uint8Array): void {
        const { texts, uppers } = this;
        for (let id = 0; id < texts.length; id += 1) {
            if (held[id] & 1) held[uppers[id]] |= 2;
        }
        for (let id = 0; id < texts.length; id += 1) {
            if (held[id] !== 0 || uppers[id] < 0) continue;
            this.ids.delete(texts[id]);
            this.weight -= texts[id].length + SLOT;
            texts[id] = '';
            uppers[id] = -1;
            this.numbers[id] = undefined;
            this.free.push(id);
        }
    }

    // The id of a text the table holds, and -1 for any other text.
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
