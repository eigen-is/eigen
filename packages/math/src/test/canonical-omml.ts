import { OMML_NAMESPACE, WORDML_NAMESPACE } from '../omml';
import { attribute, elementsOf, type MathXmlElement, textOf } from '../xml';

// C1's yardstick, written apart from the reader: an equation as Word shows it. Objects nest with their properties
// resolved to Word's defaults; every character carries its text and effective style, so run boundaries don't count.
// Only properties the tree keeps are compared; A5 lists what is dropped.

export type CanonicalItem = string | CanonicalObject;
export type CanonicalObject = { object: string; properties: Record<string, string>; children: CanonicalChild[] };
type CanonicalChild = CanonicalObject | { argument: string; content: CanonicalItem[] };

const ARGUMENTS = new Set(['e', 'num', 'den', 'sub', 'sup', 'deg', 'lim', 'fName']);
const HIDES: Record<string, string> = { sub: 'subHide', sup: 'supHide', deg: 'degHide' };
const OFF = 'off';
const DEFAULTS: Record<string, Record<string, string>> = {
    acc: { chr: '\u0302' },
    bar: { pos: 'bot' },
    borderBox: Object.fromEntries(
        ['hideTop', 'hideBot', 'hideLeft', 'hideRight', 'strikeH', 'strikeV', 'strikeBLTR', 'strikeTLBR'].map((key) => [
            key,
            OFF,
        ]),
    ),
    d: { begChr: '(', sepChr: '|', endChr: ')' },
    f: { type: 'bar' },
    groupChr: { chr: '⏟', pos: 'bot' },
    nary: { chr: '∫', limLoc: '', subHide: OFF, supHide: OFF },
    rad: { degHide: OFF },
};
const ON_OFF = new Set(['subHide', 'supHide', 'degHide', ...Object.keys(DEFAULTS.borderBox)]);
// Script, fraktur, double-struck and monospace have no italic letters to show.
const UPRIGHT_SCRIPTS = new Set(['script', 'fraktur', 'double-struck', 'monospace']);

const isM = (element: MathXmlElement, local: string) => element.ns === OMML_NAMESPACE && element.local === local;
const isW = (element: MathXmlElement, ...locals: string[]) =>
    element.ns === WORDML_NAMESPACE && locals.includes(element.local);
const child = (element: MathXmlElement | undefined, local: string) =>
    element && elementsOf(element).find((candidate) => candidate.local === local);
const val = (element: MathXmlElement | undefined) => (element ? (attribute(element, 'val') ?? '') : undefined);
const isOn = (value: string | undefined) => value !== undefined && !['0', 'off', 'false'].includes(value);

// Tracked insertions show; deletions don't, nor does an object whose control character is deleted (§22.1.2.23).
function shown(elements: MathXmlElement[]): MathXmlElement[] {
    return elements.flatMap((element) => {
        if (isW(element, 'ins', 'moveTo')) return shown(elementsOf(element));
        if (isW(element, 'del', 'moveFrom')) return [];
        const control = child(child(element, `${element.local}Pr`), 'ctrlPr');
        return control && elementsOf(control).some((part) => isW(part, 'del', 'moveFrom')) ? [] : [element];
    });
}

function characters(run: MathXmlElement): string[] {
    const parts = shown(elementsOf(run));
    const mathProperties = parts.find((part) => isM(part, 'rPr'));
    const color = val(
        child(
            parts.find((part) => isW(part, 'rPr')),
            'color',
        ),
    );
    const colorSuffix = color && color !== 'auto' ? ` #${color.toUpperCase()}` : '';
    const normal = isOn(val(child(mathProperties, 'nor')));
    const scr = val(child(mathProperties, 'scr')) ?? 'roman';
    const text = parts
        .filter((part) => isM(part, 't'))
        .map(textOf)
        .join('')
        .replace(/[\u200B\u2061-\u2064]/gu, '');
    return [...text].map((char) => {
        if (normal) return `${char}|nor${colorSuffix}`;
        let sty = val(child(mathProperties, 'sty')) ?? (/\p{L}/u.test(char) ? 'i' : 'p');
        if (UPRIGHT_SCRIPTS.has(scr)) sty = sty.replace('i', '') || 'p';
        return `${char}|${sty}|${scr}${colorSuffix}`;
    });
}

function properties(element: MathXmlElement): Record<string, string> {
    const resolved = { ...DEFAULTS[element.local] };
    const own = child(element, `${element.local}Pr`);
    for (const key of Object.keys(resolved)) {
        const value = val(child(own, key));
        if (value !== undefined) resolved[key] = ON_OFF.has(key) ? (isOn(value) ? 'on' : OFF) : value;
    }
    if (element.local === 'nary' && resolved.limLoc === '')
        resolved.limLoc = /[∫-∳⨋-⨜]/u.test(resolved.chr) ? 'subSup' : 'undOvr';
    return resolved;
}

function object(element: MathXmlElement): CanonicalObject {
    const resolved = properties(element);
    const children = shown(elementsOf(element))
        .filter((part) => !part.local.endsWith('Pr'))
        .map((part): CanonicalChild => {
            if (!ARGUMENTS.has(part.local)) return object(part);
            const hidden = HIDES[part.local] && resolved[HIDES[part.local]] === 'on';
            return { argument: part.local, content: hidden ? [] : canonicalRow(elementsOf(part)) };
        });
    return { object: element.local, properties: resolved, children };
}

function canonicalRow(elements: MathXmlElement[]): CanonicalItem[] {
    return shown(elements).flatMap((element): CanonicalItem[] => {
        if (element.ns !== OMML_NAMESPACE || element.local.endsWith('Pr')) return [];
        return isM(element, 'r') ? characters(element) : [object(element)];
    });
}

export function canonicalOmml(oMath: MathXmlElement): CanonicalItem[] {
    return canonicalRow(elementsOf(oMath));
}
