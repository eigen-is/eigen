import {
    arrowRoute,
    elementBounds,
    FREEDRAW_SIZE_FACTOR,
    linearLocalToScene,
    parseBackgroundFill,
    parsePoints,
    pointsBounds,
    type VectorElement,
    type VectorFrame,
} from '@workspace/lib/vector';
import { escapeXml } from '@workspace/lib/xml';
import { A_NS, P_NS, R_NS } from '../../../ooxml/ooxml';
import type { Relationship } from '../../../ooxml/opc';
import type { OfficeImageParts, OfficeMedia } from '../../office-image';
import { backgroundXml } from './pictures';
import { elementXml } from './shapes';

// The presentation's own parts, its master and its one blank layout, and a slide's part around its shapes.

export const NAMESPACES = `xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"`;

const GROUP_PROPERTIES =
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

// A white page under every slide, as an empty frame background prints on white paper.
export const MASTER_XML = `<p:sldMaster ${NAMESPACES}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP_PROPERTIES}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;

export const LAYOUT_XML = `<p:sldLayout ${NAMESPACES} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP_PROPERTIES}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

// What one export accumulates: each media name's parts once, whichever slide shows it first.
export type Deck = {
    // EMU per px, and the deck's width in pt, which its text sizes convert at.
    scale: number;
    slideWidth: number;
    media: Map<string, OfficeMedia>;
    images: Map<string, Image>;
    // The elbow router reads the shapes an arrow is bound to.
    byId: Map<string, VectorElement>;
};

// An SVG's raster is its PNG, its own data the svgPart beside it.
export type Image = OfficeImageParts & { media: OfficeMedia };

export type Slide = {
    deck: Deck;
    relationships: Relationship[];
    // A picture or link a slide shows twice relates once.
    rIds: Map<string, string>;
    shapes: number;
    // An arrow label's mask paints the slide's solid color, where Eigen masks the shaft out under the text.
    ground: string | undefined;
};

export function slideXml(
    frame: VectorFrame,
    elements: VectorElement[],
    deck: Deck,
): { xml: string; relationships: Relationship[] } {
    const background = parseBackgroundFill(frame.background);
    const slide: Slide = {
        deck,
        relationships: [{ type: `${R_NS}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' }],
        rIds: new Map(),
        // The tree's own group is 1.
        shapes: 1,
        ground: background?.type === 'solid' ? background.color : undefined,
    };
    // The canvas clips a slide to its frame: an element wholly outside draws nothing. A line draws its points, which a
    // peer may write past its box, and a stroke reaches half its width past them (a freehand stroke's ink is wider).
    const shown = elements.filter((el) => {
        const { minX, minY, maxX, maxY } =
            el.type === 'line' || el.type === 'freedraw'
                ? pointsBounds(parsePoints(el.points).map((p) => linearLocalToScene(el, p)))
                : elementBounds(el, arrowRoute(el, deck.byId));
        const reach = ((el.type === 'freedraw' ? FREEDRAW_SIZE_FACTOR : 1) * el.strokeWidth) / 2;
        return maxX + reach >= 0 && maxY + reach >= 0 && minX - reach <= frame.width && minY - reach <= frame.height;
    });
    const shapes = shown.map((el) => elementXml(el, slide)).join('');
    const name = frame.name ? ` name="${escapeXml(frame.name)}"` : '';
    const xml = `<p:sld ${NAMESPACES}><p:cSld${name}>${backgroundXml(background, frame, slide)}<p:spTree>${GROUP_PROPERTIES}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    return { xml, relationships: slide.relationships };
}

export function relate(slide: Slide, type: string, target: string, external?: true): string {
    const key = `${type} ${target}`;
    let rId = slide.rIds.get(key);
    if (!rId) {
        rId = `rId${slide.relationships.push({ type: `${R_NS}/${type}`, target, external })}`;
        slide.rIds.set(key, rId);
    }
    return rId;
}
