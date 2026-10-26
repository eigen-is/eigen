// Word's list counters, emulated in document order: lists that share a definition continue, and a start override
// restarts once. The paragraph reader asks it for each numbered paragraph's level, number and label.

import type { XmlElement } from '../../core/xml';
import { hasXmlName, xmlElements } from '../../core/xml';
import { W_NS } from '../../ooxml/ooxml';
import { LIST_LEVELS, spellNumber } from '../../ooxml/wordml';
import { symbolOf } from './docx-fonts';
import { onOff, roundedInt, w, wChild } from './package';
import type { ParaProps, Styles } from './styles';
import { MAX_CHAIN, readParaProps } from './styles';

type Level = {
    start: number;
    format: string;
    text: string;
    // The level's paragraph properties, its indent, which sit between the paragraph style's and the paragraph's own.
    pPr: ParaProps;
    restart?: number;
    suffix: string;
    // The paragraph style the level numbers.
    style?: string;
    // The label shows every number in arabic.
    legal: boolean;
};

export type ListRef = {
    key: string;
    ordered: boolean;
    format: string;
    number: number;
    // Read only for a numbered heading, which keeps its number as text.
    label(): string;
    pPr: ParaProps;
    suffix: string;
};

// Word's number range.
const MAX_START = 32_767;
// Longer than any label Word draws; uncapped, a long lvlText or a letter count would grow with every item.
const MAX_LABEL_CHARS = 255;

type Override = { start?: number; level?: Level };

type Definitions = {
    abstracts: Map<string, { levels: Map<number, Level>; styleLink?: string }>;
    nums: Map<string, { abstractId: string; overrides: Map<number, Override> }>;
};

export class Numbering {
    private readonly abstracts: Definitions['abstracts'];
    private readonly nums: Definitions['nums'];
    private readonly counters = new Map<string, (number | undefined)[]>();
    private readonly started = new Set<string>();

    public constructor(
        definitions: Definitions,
        private readonly styles: Styles,
    ) {
        this.abstracts = definitions.abstracts;
        this.nums = definitions.nums;
    }

    // A story whose lists count on their own, a band's or a note's: the definitions shared, every counter unstarted.
    public restarted(): Numbering {
        return new Numbering({ abstracts: this.abstracts, nums: this.nums }, this.styles);
    }

    // A numbering style's abstractNum holds no levels of its own: it links to the style, whose numPr names the real one.
    private abstractOf(numId: string): { id: string; levels: Map<number, Level> } | undefined {
        const seen = [numId];
        for (let id = numId; ; ) {
            const num = this.nums.get(id);
            const abstract = num && this.abstracts.get(num.abstractId);
            if (!num || !abstract) return undefined;
            const linked = abstract.styleLink && this.styles.para(abstract.styleLink).numId;
            if (!linked || seen.includes(linked) || seen.length === MAX_CHAIN)
                return { id: num.abstractId, levels: abstract.levels };
            seen.push(linked);
            id = linked;
        }
    }

    // ECMA-376 §17.9.23: a paragraph style's numbering without a level takes the level whose pStyle names the style.
    public styleLevel(numId: string, styleId: string | undefined): number | undefined {
        for (const [ilvl, level] of this.abstractOf(numId)?.levels ?? []) if (level.style === styleId) return ilvl;
        return undefined;
    }

    public next(numId: string, ilvl: number): ListRef | undefined {
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
        else counters[ilvl] = current === undefined ? level.start : current < MAX_START ? current + 1 : 1;
        this.started.add(startKey);
        for (let deeper = ilvl + 1; deeper < LIST_LEVELS; deeper++) {
            const restart = (num.overrides.get(deeper)?.level ?? abstract.levels.get(deeper))?.restart;
            if (restart === undefined || restart > ilvl) counters[deeper] = undefined;
        }
        const shown = [...counters];
        return {
            // Numbers that follow on join lists sharing a definition; bullets show none, so each w:num is a list.
            key: level.format === 'bullet' ? `${abstract.id}:${numId}` : abstract.id,
            ordered: level.format !== 'bullet',
            format: level.format,
            number: counters[ilvl] ?? level.start,
            // Text and level numbers alternate; building stops at the cap, as a letter count grows with every item.
            label: () => {
                let label = '';
                for (const [index, piece] of level.text.split(/%([1-9])/).entries()) {
                    const counter = Number(piece) - 1;
                    const format = level.legal ? 'decimal' : (abstract.levels.get(counter) ?? level).format;
                    label +=
                        index % 2 === 0
                            ? piece
                            : spellNumber(shown[counter] ?? abstract.levels.get(counter)?.start ?? 1, format);
                    if (label.length >= MAX_LABEL_CHARS) break;
                }
                return label.slice(0, MAX_LABEL_CHARS);
            },
            pPr: level.pPr,
            suffix: level.suffix,
        };
    }
}

export function readNumbering(root: XmlElement | undefined, styles: Styles): Numbering {
    const abstracts: Definitions['abstracts'] = new Map();
    const nums: Definitions['nums'] = new Map();
    for (const element of root ? xmlElements(root) : []) {
        if (hasXmlName(element, W_NS, 'abstractNum')) {
            const levels = new Map<number, Level>();
            // Word draws nine levels; one past them is never drawn, and every paragraph would look through it.
            for (const lvl of xmlElements(element)) {
                const ilvl = roundedInt(w(lvl, 'ilvl')) ?? 0;
                if (hasXmlName(lvl, W_NS, 'lvl') && ilvl >= 0 && ilvl < LIST_LEVELS) levels.set(ilvl, readLevel(lvl));
            }
            abstracts.set(w(element, 'abstractNumId') ?? '', {
                levels,
                styleLink: w(wChild(element, 'numStyleLink'), 'val'),
            });
        }
        if (hasXmlName(element, W_NS, 'num')) {
            const overrides = new Map<number, Override>();
            for (const override of xmlElements(element)) {
                if (!hasXmlName(override, W_NS, 'lvlOverride')) continue;
                const lvl = wChild(override, 'lvl');
                overrides.set(roundedInt(w(override, 'ilvl')) ?? 0, {
                    start: startOf(wChild(override, 'startOverride')),
                    level: lvl && readLevel(lvl),
                });
            }
            nums.set(w(element, 'numId') ?? '', {
                abstractId: w(wChild(element, 'abstractNumId'), 'val') ?? '',
                overrides,
            });
        }
    }
    return new Numbering({ abstracts, nums }, styles);
}

// ECMA-376 says a missing start is 0; files that omit it are hand-made and mean 1.
function startOf(element: XmlElement | undefined): number | undefined {
    const start = roundedInt(w(element, 'val'));
    if (start === undefined) return undefined;
    return start >= 0 && start <= MAX_START ? start : 1;
}

// Word spells a Symbol or Wingdings bullet in the private use area, which only that font draws.
const PRIVATE_USE = /[\uf000-\uf0ff]/g;

function readLevel(lvl: XmlElement): Level {
    // Cut once, so a long lvlText costs each label what a short one does.
    const text = (w(wChild(lvl, 'lvlText'), 'val') ?? '').slice(0, MAX_LABEL_CHARS);
    const font = w(wChild(wChild(lvl, 'rPr'), 'rFonts'), 'ascii');
    return {
        start: startOf(wChild(lvl, 'start')) ?? 1,
        format: w(wChild(lvl, 'numFmt'), 'val') ?? 'decimal',
        text: font ? text.replace(PRIVATE_USE, (char) => symbolOf(font, char.charCodeAt(0)) ?? char) : text,
        pPr: readParaProps(wChild(lvl, 'pPr')),
        restart: roundedInt(w(wChild(lvl, 'lvlRestart'), 'val')),
        suffix: w(wChild(lvl, 'suff'), 'val') ?? 'tab',
        style: w(wChild(lvl, 'pStyle'), 'val'),
        legal: onOff(wChild(lvl, 'isLgl')) ?? false,
    };
}
