import type { InlineStringSegment } from '@workspace/lib/sheets';
import { SML_NS } from '../../core/ooxml';
import { hasXmlName, type XmlElement, xmlChild, xmlElements, xmlText } from '../../core/xml';
import { readInBatches } from './package';
import { fontLook, type ThemePalette } from './styles';

// Shared and inline strings. A rich string keeps its runs, each with its font's look, beside the text a cell shows.
export type SharedString = string | { text: string; runs: InlineStringSegment[] };

export function readSharedStrings(part: Uint8Array | undefined, palette: ThemePalette): SharedString[] {
    const strings: SharedString[] = [];
    for (const si of part ? readInBatches(part, undefined, 'si').children : []) strings.push(stringOf(si, palette));
    return strings;
}

// An <si> or an <is>: its text and runs, never a phonetic run's reading of them.
export function stringOf(element: XmlElement, palette: ThemePalette): SharedString {
    const runs: InlineStringSegment[] = [];
    let rich = false;
    for (const child of xmlElements(element)) {
        const run = hasXmlName(child, SML_NS, 'r');
        const t = run ? xmlChild(child, SML_NS, 't') : hasXmlName(child, SML_NS, 't') ? child : undefined;
        if (run) rich = true;
        if (run || t)
            runs.push({
                v: t ? decoded(xmlText(t)) : '',
                ...(run && fontLook(xmlChild(child, SML_NS, 'rPr'), palette)),
            });
    }
    const text = runs.map((run) => run.v).join('');
    return rich ? { text, runs } : text;
}

export function textOf(string: SharedString): string {
    return typeof string === 'string' ? string : string.text;
}

// A character XML can't hold is written _xHHHH_, and _x005F_ escapes the underscore of a literal one.
const ESCAPED = /_x([0-9A-Fa-f]{4})_/g;

function decoded(text: string): string {
    return text.includes('_x')
        ? text.replace(ESCAPED, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        : text;
}
