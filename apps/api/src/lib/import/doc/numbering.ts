import { type XmlElement, xmlElements } from '../../core/xml';
import { W_NS } from '../../export/doc/ooxml';
import { int, is, w, wChild } from './package';
import { readParaProps, type Styles } from './styles';

// Word's counters, emulated in document order: lists sharing a definition continue, a start override restarts once.

type Level = { start: number; format: string; text: string; indLeft?: number; restart?: number; suffix: string };

export type ListRef = {
    key: string;
    ordered: boolean;
    format: string;
    number: number;
    // Read only for a numbered heading, which keeps its number as text.
    label(): string;
    indLeft?: number;
    suffix: string;
};

// Word's levels and its number range.
export const MAX_LEVEL = 8;
const MAX_START = 32_767;
// Longer than any label Word draws; uncapped, a long lvlText or a letter count would grow with every item.
const MAX_LABEL_CHARS = 255;

type Override = { start?: number; level?: Level };

export class Numbering {
    private readonly abstracts = new Map<string, { levels: Map<number, Level>; styleLink?: string }>();
    private readonly nums = new Map<string, { abstractId: string; overrides: Map<number, Override> }>();
    private readonly counters = new Map<string, (number | undefined)[]>();
    private readonly started = new Set<string>();

    constructor(
        root: XmlElement | undefined,
        private readonly styles: Styles,
    ) {
        for (const element of root ? xmlElements(root) : []) {
            if (is(element, W_NS, 'abstractNum')) {
                const levels = new Map<number, Level>();
                for (const lvl of xmlElements(element)) {
                    if (is(lvl, W_NS, 'lvl')) levels.set(int(w(lvl, 'ilvl')) ?? 0, readLevel(lvl));
                }
                this.abstracts.set(w(element, 'abstractNumId') ?? '', {
                    levels,
                    styleLink: w(wChild(element, 'numStyleLink'), 'val'),
                });
            }
            if (is(element, W_NS, 'num')) {
                const overrides = new Map<number, Override>();
                for (const override of xmlElements(element)) {
                    if (!is(override, W_NS, 'lvlOverride')) continue;
                    const lvl = wChild(override, 'lvl');
                    overrides.set(int(w(override, 'ilvl')) ?? 0, {
                        start: startOf(wChild(override, 'startOverride')),
                        level: lvl && readLevel(lvl),
                    });
                }
                this.nums.set(w(element, 'numId') ?? '', {
                    abstractId: w(wChild(element, 'abstractNumId'), 'val') ?? '',
                    overrides,
                });
            }
        }
    }

    // A numbering style's abstractNum holds no levels of its own: it links to the style, whose numPr names the real one.
    private abstractOf(numId: string): { id: string; levels: Map<number, Level> } | undefined {
        const seen = new Set<string>();
        for (let id = numId; ; ) {
            seen.add(id);
            const num = this.nums.get(id);
            const abstract = num && this.abstracts.get(num.abstractId);
            if (!num || !abstract) return undefined;
            const linked = abstract.styleLink && this.styles.para(abstract.styleLink).numId;
            if (!linked || seen.has(linked)) return { id: num.abstractId, levels: abstract.levels };
            id = linked;
        }
    }

    next(numId: string, ilvl: number): ListRef | undefined {
        const num = this.nums.get(numId);
        const abstract = this.abstractOf(numId);
        if (!num || !abstract) return undefined;
        const override = num.overrides.get(ilvl);
        const level = override?.level ?? abstract.levels.get(ilvl);
        if (!level || level.format === 'none') return undefined;
        let counters = this.counters.get(abstract.id);
        if (!counters) {
            counters = [];
            this.counters.set(abstract.id, counters);
        }
        const startKey = `${numId}:${ilvl}`;
        const current = counters[ilvl];
        if (override?.start !== undefined && !this.started.has(startKey)) counters[ilvl] = override.start;
        else counters[ilvl] = current === undefined ? level.start : current + 1;
        this.started.add(startKey);
        for (let deeper = ilvl + 1; deeper <= MAX_LEVEL; deeper++) {
            const restart = (num.overrides.get(deeper)?.level ?? abstract.levels.get(deeper))?.restart;
            if (restart === undefined || restart > ilvl) counters[deeper] = undefined;
        }
        const shown = [...counters];
        return {
            key: abstract.id,
            ordered: level.format !== 'bullet',
            format: level.format,
            number: counters[ilvl] ?? level.start,
            // Text and level numbers alternate; building stops at the cap, so a long lvlText costs what a short one does.
            label: () => {
                let label = '';
                for (const [index, piece] of level.text.split(/%([1-9])/).entries()) {
                    const counter = Number(piece) - 1;
                    const format = (abstract.levels.get(counter) ?? level).format;
                    label +=
                        index % 2 === 0
                            ? piece
                            : formatNumber(shown[counter] ?? abstract.levels.get(counter)?.start ?? 1, format);
                    if (label.length >= MAX_LABEL_CHARS) break;
                }
                return label.slice(0, MAX_LABEL_CHARS);
            },
            indLeft: level.indLeft,
            suffix: level.suffix,
        };
    }
}

// ECMA-376 says a missing start is 0; files that omit it are hand-made and mean 1.
function startOf(element: XmlElement | undefined): number | undefined {
    const start = int(w(element, 'val'));
    if (start === undefined) return undefined;
    return start >= 0 && start <= MAX_START ? start : 1;
}

function readLevel(lvl: XmlElement): Level {
    return {
        start: startOf(wChild(lvl, 'start')) ?? 1,
        format: w(wChild(lvl, 'numFmt'), 'val') ?? 'decimal',
        text: w(wChild(lvl, 'lvlText'), 'val') ?? '',
        indLeft: readParaProps(wChild(lvl, 'pPr')).indLeft,
        restart: int(w(wChild(lvl, 'lvlRestart'), 'val')),
        suffix: w(wChild(lvl, 'suff'), 'val') ?? 'tab',
    };
}

function formatNumber(value: number, format: string): string {
    switch (format) {
        case 'lowerLetter':
        case 'upperLetter': {
            const index = Math.max(1, value) - 1;
            const letters = String.fromCharCode(97 + (index % 26)).repeat(Math.floor(index / 26) + 1);
            return format === 'upperLetter' ? letters.toUpperCase() : letters;
        }
        case 'lowerRoman':
        case 'upperRoman': {
            const roman = toRoman(value);
            return format === 'upperRoman' ? roman : roman.toLowerCase();
        }
        case 'decimalZero':
            return value < 10 ? `0${value}` : String(value);
        case 'bullet':
        case 'none':
            return '';
        default:
            return String(value);
    }
}

const ROMAN_NUMERALS: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
];

function toRoman(value: number): string {
    if (value <= 0 || value >= 4000) return String(value);
    let rest = value;
    let roman = '';
    for (const [amount, numeral] of ROMAN_NUMERALS) {
        while (rest >= amount) {
            roman += numeral;
            rest -= amount;
        }
    }
    return roman;
}
