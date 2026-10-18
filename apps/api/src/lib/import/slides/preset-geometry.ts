import { readFileSync } from 'node:fs';
import type { Corners } from '@workspace/lib/vector';
import { A_NS } from '../../core/ooxml';
import { parseXml, type XmlElement, xmlElements } from '../../core/xml';
import { type CustomGeometry, customGeometry } from './custom-geometry';
import { guideListOf } from './guides';
import { childOf } from './lookup';

// A shape's a:prstGeom: one of the few presets a canvas kind draws, else the paths ECMA-376's preset definitions draw.
// The file is Ecma's, unchanged (NOTICE beside it): each preset is its avLst's defaults, gdLst and pathLst, as custGeom
// spells them.

export type PresetKind = { type: 'ellipse' } | { type: 'rectangle' | 'diamond'; corners: Corners };

const PRESET_KINDS: ReadonlyMap<string, PresetKind> = new Map<string, PresetKind>([
    ['rect', { type: 'rectangle', corners: 'straight' }],
    ['flowChartProcess', { type: 'rectangle', corners: 'straight' }],
    ['roundRect', { type: 'rectangle', corners: 'curved' }],
    ['ellipse', { type: 'ellipse' }],
    ['flowChartConnector', { type: 'ellipse' }],
    ['diamond', { type: 'diamond', corners: 'straight' }],
    ['flowChartDecision', { type: 'diamond', corners: 'straight' }],
]);

export function presetKind(preset: string): PresetKind | undefined {
    return PRESET_KINDS.get(preset);
}

const PRESETS_FILE = new URL('./presetShapeDefinitions.xml', import.meta.url);

// Read on the first preset a deck draws, once for the process.
let presets: ReadonlyMap<string, XmlElement> | undefined;

// The preset's paths in its box, `width` × `height` EMU, for its adjust values: the shape's avLst (untrusted) over the
// preset's defaults, by name, a name the preset doesn't define ignored. Undefined for an unknown preset, or past a cap.
export function presetGeometry(
    preset: string,
    avLst: XmlElement | undefined,
    width: number,
    height: number,
): CustomGeometry[] | undefined {
    if (!presets) {
        const root = parseXml(readFileSync(PRESETS_FILE));
        presets = new Map(root ? xmlElements(root).map((definition) => [definition.local, definition]) : []);
    }
    const definition = presets.get(preset);
    if (!definition) return undefined;
    const defaults = new Set(guideListOf(childOf(definition, A_NS, 'avLst')).map(([name]) => name));
    const adjustments = new Map(guideListOf(avLst).filter(([name]) => defaults.has(name)));
    return customGeometry(definition, width, height, [...adjustments]);
}
