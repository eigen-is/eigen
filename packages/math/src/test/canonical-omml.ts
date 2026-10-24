import { OMML_NAMESPACE, WORDML_NAMESPACE } from '../omml';
import type { MathXmlElement } from '../xml';
import { attribute, elementsOf, textOf } from '../xml';

// The OMML round trip's yardstick, written apart from the reader: an equation as Word shows it. Objects nest with their
// properties resolved to Word's defaults; every character carries its text and effective style, so run boundaries don't
// count. Only properties the tree keeps are compared; MATH.md lists what is dropped.

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
    // A separator shows only between parts.
    if (element.local === 'd' && shown(elementsOf(element)).filter((part) => isM(part, 'e')).length < 2)
        resolved.sepChr = DEFAULTS.d.sepChr;
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

// ── The round trip's normalisations ────────────────────────────────────────────────────────────────────────────

function walk(row: CanonicalItem[], visit: (item: CanonicalItem) => CanonicalItem[]): CanonicalItem[] {
    return row.flatMap((item) => visit(typeof item === 'string' ? item : descend(item, visit)));
}

function descend(object: CanonicalObject, visit: (item: CanonicalItem) => CanonicalItem[]): CanonicalObject {
    const children = object.children.map((child) =>
        'argument' in child ? { ...child, content: walk(child.content, visit) } : descend(child, visit),
    );
    return { ...object, children };
}

const objects = (local: string, rewrite: (object: CanonicalObject) => CanonicalItem[]) => (row: CanonicalItem[]) =>
    walk(row, (item) => (typeof item !== 'string' && item.object === local ? rewrite(item) : [item]));

const eachCharacter = (rewrite: (char: string) => string) => (row: CanonicalItem[]) =>
    walk(row, (item) => [typeof item === 'string' ? rewrite(item) : item]);

const argument = (object: CanonicalObject, local: string) =>
    object.children.flatMap((child) => ('argument' in child && child.argument === local ? child.content : []));

const SPACING_TWINS: Record<string, string> = { '˙': '\u0307', '‾': '\u0305' };

function revealEmpty(object: CanonicalObject): CanonicalItem[] {
    const properties = { ...object.properties };
    for (const [slot, hide] of [
        ['sub', 'subHide'],
        ['sup', 'supHide'],
        ['deg', 'degHide'],
    ]) {
        if (properties[hide] === 'off' && argument(object, slot).length === 0) properties[hide] = 'on';
    }
    return [{ ...object, properties }];
}

// What Word loses and the canonical form folds, each with the equations it changes: omml.test.ts keeps the list exact.
export const NORMALISATIONS: { reason: string; indices: number[]; apply: (row: CanonicalItem[]) => CanonicalItem[] }[] =
    [
        {
            reason: 'a spacing accent character folds to its combining twin',
            indices: [71, 87],
            apply: objects('acc', (acc) => [
                { ...acc, properties: { chr: SPACING_TWINS[acc.properties.chr] ?? acc.properties.chr } },
            ]),
        },
        {
            reason: 'a linear fraction reads as the row a/b',
            indices: [3],
            apply: objects('f', (f) =>
                f.properties.type === 'lin' ? [...argument(f, 'num'), '/|p|roman', ...argument(f, 'den')] : [f],
            ),
        },
        {
            reason: 'double-struck and monospace keep the script and drop the weight',
            indices: [172],
            apply: eachCharacter((char) => char.replace(/\|b\|(double-struck|monospace)/, '|p|$1')),
        },
        {
            reason: 'a space between math characters carries no style or colour',
            indices: [41, 172],
            apply: eachCharacter((char) =>
                /^[ \u2003\u2004\u2009\u205F]\|(?!nor)/u.test(char) ? `${char[0]}|p|roman` : char,
            ),
        },
        {
            reason: 'an operator hyphen-minus reads as the minus sign U+2212',
            indices: [12, 43, 44, 56, 57, 60, 61, 63, 79, 80, 83, 90, 91, 156, 158, 159, 160],
            apply: eachCharacter((char) => (/^-\|(?!nor)/.test(char) ? `\u2212${char.slice(1)}` : char)),
        },
        {
            reason: 'an empty script or degree shows nothing, so it reads as hidden',
            indices: [18, 69],
            apply: (row) => walk(row, (item) => (typeof item === 'string' ? [item] : revealEmpty(item))),
        },
    ];
