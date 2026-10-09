import { LIST_LEVELS, spellNumber, W_NS } from '../../core/ooxml';
import { type XmlElement, xmlElements } from '../../core/xml';
import { int, is, w, wChild } from './package';
import { MAX_CHAIN, type ParaProps, readParaProps, type Styles } from './styles';

// Word's counters, emulated in document order: lists sharing a definition continue, a start override restarts once.

// pPr: the level's paragraph properties, its indent, which sit between the paragraph style's and the paragraph's own.
type Level = { start: number; format: string; text: string; pPr: ParaProps; restart?: number; suffix: string };

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
                    const format = (abstract.levels.get(counter) ?? level).format;
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
        // Cut once, so a long lvlText costs each label what a short one does.
        text: (w(wChild(lvl, 'lvlText'), 'val') ?? '').slice(0, MAX_LABEL_CHARS),
        pPr: readParaProps(wChild(lvl, 'pPr')),
        restart: int(w(wChild(lvl, 'lvlRestart'), 'val')),
        suffix: w(wChild(lvl, 'suff'), 'val') ?? 'tab',
    };
}
