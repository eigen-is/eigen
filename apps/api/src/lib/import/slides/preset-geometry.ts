import { readFileSync } from 'node:fs';
import type { Corners } from '@workspace/lib/vector';
import { parseXml, type XmlElement, xmlElements } from '../../core/xml';
import { A_NS } from '../../ooxml/ooxml';
import { type CustomGeometry, customGeometry } from './custom-geometry';
import { type GuideList, guideListOf } from './guides';
import { cachedBy, childOf } from './lookup';

// A shape's a:prstGeom: one of the few presets a canvas kind draws, else the paths ECMA-376's preset definitions draw.
// The file is Ecma's, unchanged (NOTICE beside it): each preset is its avLst's defaults, gdLst and pathLst, as custGeom
// spells them.

export type PresetKind = { type: 'ellipse' } | { type: 'rectangle' | 'diamond'; corners: Corners };

export const PRESET_KINDS: ReadonlyMap<string, PresetKind> = new Map<string, PresetKind>([
    ['rect', { type: 'rectangle', corners: 'straight' }],
    ['flowChartProcess', { type: 'rectangle', corners: 'straight' }],
    ['roundRect', { type: 'rectangle', corners: 'curved' }],
    ['ellipse', { type: 'ellipse' }],
    ['flowChartConnector', { type: 'ellipse' }],
    ['diamond', { type: 'diamond', corners: 'straight' }],
    ['flowChartDecision', { type: 'diamond', corners: 'straight' }],
]);

const PRESETS_FILE = new URL('./presetShapeDefinitions.xml', import.meta.url);

// What the file gets wrong, by preset, in its own spelling. It has no upArrow, upDownArrow twice instead: this is its
// downArrow turned upright, as LibreOffice's presets, taken from PowerPoint, define it.
const OVERRIDES: ReadonlyMap<string, string> = new Map([
    [
        'upArrow',
        [
            `<upArrow xmlns="${A_NS}">`,
            '<avLst><gd name="adj1" fmla="val 50000"/><gd name="adj2" fmla="val 50000"/></avLst>',
            '<gdLst><gd name="maxAdj2" fmla="*/ 100000 h ss"/><gd name="a1" fmla="pin 0 adj1 100000"/>',
            '<gd name="a2" fmla="pin 0 adj2 maxAdj2"/><gd name="dy2" fmla="*/ ss a2 100000"/>',
            '<gd name="y2" fmla="+- t dy2 0"/><gd name="dx1" fmla="*/ w a1 200000"/>',
            '<gd name="x1" fmla="+- hc 0 dx1"/><gd name="x2" fmla="+- hc dx1 0"/></gdLst>',
            '<pathLst><path><moveTo><pt x="l" y="y2"/></moveTo><lnTo><pt x="hc" y="t"/></lnTo>',
            '<lnTo><pt x="r" y="y2"/></lnTo><lnTo><pt x="x2" y="y2"/></lnTo><lnTo><pt x="x2" y="b"/></lnTo>',
            '<lnTo><pt x="x1" y="b"/></lnTo><lnTo><pt x="x1" y="y2"/></lnTo><close/></path></pathLst>',
            '</upArrow>',
        ].join(''),
    ],
]);

// Read on the first preset a deck draws, once for the process.
let presets: ReadonlyMap<string, XmlElement> | undefined;

// The preset's paths in its box, `width` × `height` EMU, mirrored across it if `mirrored`, for its adjust values: the
// shape's avLst (untrusted) over the preset's defaults, by name, a name the preset doesn't define ignored. Undefined for
// an unknown preset, or past a cap.
export function presetGeometry(
    preset: string,
    avLst: XmlElement | undefined,
    width: number,
    height: number,
    mirrored = false,
): CustomGeometry[] | undefined {
    if (!presets) {
        const root = parseXml(readFileSync(PRESETS_FILE));
        const found = new Map(root ? xmlElements(root).map((definition) => [definition.local, definition]) : []);
        for (const [name, definition] of OVERRIDES) {
            const parsed = parseXml(definition);
            if (parsed) found.set(name, parsed);
        }
        presets = found;
    }
    const definition = presets.get(preset);
    if (!definition) return undefined;
    return customGeometry(definition, width, height, mirrored, avLst ? adjustmentsOf(avLst, definition) : []);
}

const adjustments = cachedBy<XmlElement, GuideList>();

// The shape's adjust values the preset defines, the last of each name, read once for the shape's avLst.
function adjustmentsOf(avLst: XmlElement, definition: XmlElement): GuideList {
    return adjustments(avLst, definition, () => {
        const defaults = new Set(guideListOf(childOf(definition, A_NS, 'avLst')).map(([name]) => name));
        return [...new Map(guideListOf(avLst).filter(([name]) => defaults.has(name)))];
    });
}
