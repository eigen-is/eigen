// The workbook's shared strings, read in batches, and a cell's inline string, each as plain or rich text. A rich string
// keeps its runs beside the text a cell shows. The grid reader looks a cell's string up here.

import type { InlineStringSegment } from '@workspace/lib/sheets';
import type { XmlElement } from '../../core/xml';
import { hasXmlName, xmlChild, xmlElements, xmlText } from '../../core/xml';
import { SML_NS } from '../../ooxml/ooxml';
import { decodeEscapes } from '../../ooxml/spreadsheetml';
import type { ReadBudget } from './package';
import { readInBatches } from './package';
import type { ThemePalette } from './styles';
import { fontLook } from './styles';

// A run with properties is in its own font. A run without, or text beside the runs, is a plain string in its cell's.
export type SharedString = string | { text: string; runs: (string | InlineStringSegment)[] };

export function readSharedStrings(
    part: Uint8Array | undefined,
    palette: ThemePalette,
    budget: ReadBudget,
): SharedString[] {
    const strings: SharedString[] = [];
    for (const si of part ? readInBatches(part, undefined, 'si', budget).children : [])
        strings.push(readString(si, palette));
    return strings;
}

// An <si> or an <is>: its text and runs, never a phonetic run's reading of them.
export function readString(element: XmlElement, palette: ThemePalette): SharedString {
    const runs: (string | InlineStringSegment)[] = [];
    let rich = false;
    for (const child of xmlElements(element)) {
        const run = hasXmlName(child, SML_NS, 'r');
        const t = run ? xmlChild(child, SML_NS, 't') : hasXmlName(child, SML_NS, 't') ? child : undefined;
        if (run) rich = true;
        if (!run && !t) continue;
        const text = t ? decodeEscapes(xmlText(t)) : '';
        const properties = run ? xmlChild(child, SML_NS, 'rPr') : undefined;
        runs.push(properties ? { v: text, ...fontLook(properties, palette) } : text);
    }
    const text = runs.map((run) => (typeof run === 'string' ? run : run.v)).join('');
    return rich ? { text, runs } : text;
}

export function sharedStringText(string: SharedString): string {
    return typeof string === 'string' ? string : string.text;
}
