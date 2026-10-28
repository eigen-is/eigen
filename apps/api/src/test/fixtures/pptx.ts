import type { XmlElement } from '../../lib/core/xml';
import { writeZip } from '../../lib/ooxml/zip';

// Hand-built .pptx packages for the pptx import: every part the reader reads is visible in the test that uses it.
// 16:9 at 12,192,000 × 6,858,000 EMU by default, which is 6,350 EMU a frame px, so 635,000 EMU is 100 px.

export const PX = 6350;

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const NS = `xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"`;
export const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const PML = 'application/vnd.openxmlformats-officedocument.presentationml';
export const PRESENTATION_TYPE = `${PML}.presentation.main+xml`;

export type SlideFixture = {
    shapes?: string;
    // p:cSld's p:bg content.
    bg?: string;
    // 1-based; 0 for none.
    layout?: number;
    // Attributes on p:sld, and children after p:cSld (p:clrMapOvr).
    attributes?: string;
    after?: string;
    rels?: string;
};
export type LayoutFixture = { shapes?: string; bg?: string; master?: number; attributes?: string; rels?: string };
export type MasterFixture = { shapes?: string; bg?: string; clrMap?: string; txStyles?: string; rels?: string };

export type PptxFixture = {
    slides: SlideFixture[];
    layouts?: LayoutFixture[];
    masters?: MasterFixture[];
    theme?: string;
    // Relationships of the theme part, which name a style matrix's pictures.
    themeRels?: string;
    sldSz?: string;
    presentation?: string;
    mainType?: string;
    // Content-type overrides and extra parts, or parts replaced.
    types?: string;
    files?: Record<string, string | Uint8Array>;
};

// Numbers, or the strings a hostile file writes.
type Emu = number | string;
export const xfrm = (x: Emu, y: Emu, cx: Emu, cy: Emu, attributes = '', inner = '') =>
    `<a:xfrm${attributes}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/>${inner}</a:xfrm>`;

// A box in frame px, as EMU on the default slide.
export const box = (x: number, y: number, width: number, height: number, attributes = '') =>
    xfrm(x * PX, y * PX, width * PX, height * PX, attributes);

// rPr's attributes and its children.
export const run = (text: string, attributes = '', inner = '') =>
    `<a:r><a:rPr lang="en-US"${attributes}>${inner}</a:rPr><a:t>${text}</a:t></a:r>`;
export const para = (text: string, attributes = '', inner = '') => `<a:p>${run(text, attributes, inner)}</a:p>`;

let ids = 1;

const styleOf = (style: string | undefined) => (style === undefined ? '' : `<p:style>${style}</p:style>`);

export function sp(options: {
    name?: string;
    ph?: string;
    xfrm?: string;
    geom?: string;
    spPr?: string;
    text?: string;
    txBox?: boolean;
    hidden?: boolean;
    // a:lstStyle's content.
    lstStyle?: string;
    // p:style's content.
    style?: string;
}): string {
    const id = ids++;
    const geometry = options.geom ? `<a:prstGeom prst="${options.geom}"><a:avLst/></a:prstGeom>` : '';
    const body =
        options.text === undefined
            ? ''
            : `<p:txBody><a:bodyPr/><a:lstStyle>${options.lstStyle ?? ''}</a:lstStyle>${options.text}</p:txBody>`;
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${options.name ?? `Shape ${id}`}"${options.hidden ? ' hidden="1"' : ''}/><p:cNvSpPr${options.txBox ? ' txBox="1"' : ''}/><p:nvPr>${options.ph ?? ''}</p:nvPr></p:nvSpPr><p:spPr>${options.xfrm ?? ''}${geometry}${options.spPr ?? ''}</p:spPr>${styleOf(options.style)}${body}</p:sp>`;
}

// p:style's references, each with its colour; its fontRef names the minor font.
export const styleRef = (kind: 'lnRef' | 'fillRef', idx: number, color = '<a:schemeClr val="accent2"/>') =>
    `<a:${kind} idx="${idx}">${color}</a:${kind}>`;
export const styleRefs = (fill: number, ln: number, color?: string) =>
    `${styleRef('lnRef', ln, color)}${styleRef('fillRef', fill, color)}<a:effectRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:effectRef><a:fontRef idx="minor"/>`;

// `av` is the preset's avLst content, its adjust values.
export function cxn(options: { xfrm: string; geom?: string; av?: string; ln?: string; style?: string }): string {
    const id = ids++;
    return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Connector ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${options.xfrm}<a:prstGeom prst="${options.geom ?? 'straightConnector1'}"><a:avLst>${options.av ?? ''}</a:avLst></a:prstGeom>${options.ln ?? ''}</p:spPr>${styleOf(options.style)}</p:cxnSp>`;
}

export function pic(options: {
    xfrm?: string;
    embed?: string;
    svg?: string;
    ph?: string;
    link?: string;
    geom?: string;
}): string {
    const id = ids++;
    const svg = options.svg
        ? `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${options.svg}"/></a:ext></a:extLst>`
        : '';
    const target = options.link ? `r:link="${options.link}"` : options.embed ? `r:embed="${options.embed}"` : '';
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr>${options.ph ?? ''}</p:nvPr></p:nvPicPr><p:blipFill><a:blip ${target}>${svg}</a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${options.xfrm ?? ''}<a:prstGeom prst="${options.geom ?? 'rect'}"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

export function grp(xfrmXml: string, children: string): string {
    const id = ids++;
    return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${xfrmXml}</p:grpSpPr>${children}</p:grpSp>`;
}

// A group laid out in its own child space: chOff/chExt beside off/ext.
export const groupXfrm = (
    off: [number, number, number, number],
    child: [number, number, number, number],
    attributes = '',
) =>
    xfrm(
        off[0],
        off[1],
        off[2],
        off[3],
        attributes,
        `<a:chOff x="${child[0]}" y="${child[1]}"/><a:chExt cx="${child[2]}" cy="${child[3]}"/>`,
    );

// `data` is a:graphicData's content: a chart's c:chart reference.
export function graphicFrame(uri: string, x: number, y: number, cx: number, cy: number, data = ''): string {
    const id = ids++;
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Frame ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm><a:graphic><a:graphicData uri="${uri}">${data}</a:graphicData></a:graphic></p:graphicFrame>`;
}

export const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const DSP = 'http://schemas.microsoft.com/office/drawing/2008/diagram';
export const DIAGRAM_DATA_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml';
export const DIAGRAM_DRAWING_TYPE = 'application/vnd.ms-office.drawingml.diagramDrawing+xml';

// A shape of the drawing PowerPoint caches of a SmartArt graphic, as the corpus's org charts write one: its
// dsp:style's references paint black, and its text sits in a dsp:txXfrm of its own. `xfrm` is relative to the
// graphic's frame.
export function dspSp(options: {
    xfrm: string;
    geom?: string;
    spPr?: string;
    style?: string;
    text?: string;
    txXfrm?: string;
}): string {
    const style =
        options.style ??
        '<a:lnRef idx="2"><a:scrgbClr r="0" g="0" b="0"/></a:lnRef><a:fillRef idx="1"><a:scrgbClr r="0" g="0" b="0"/></a:fillRef><a:effectRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef>';
    const body =
        options.text === undefined
            ? ''
            : `<dsp:txBody><a:bodyPr spcFirstLastPara="0" vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:noAutofit/></a:bodyPr><a:lstStyle/>${options.text}</dsp:txBody>`;
    return `<dsp:sp modelId="{${ids++}}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr>${options.xfrm}<a:prstGeom prst="${options.geom ?? 'rect'}"><a:avLst/></a:prstGeom>${options.spPr ?? ''}</dsp:spPr><dsp:style>${style}</dsp:style>${body}${options.txXfrm ?? ''}</dsp:sp>`;
}

// A dsp:txXfrm at a box in frame px, relative to the graphic's frame.
export const textBox = (x: number, y: number, width: number, height: number, attributes = '') =>
    `<dsp:txXfrm${attributes}><a:off x="${x * PX}" y="${y * PX}"/><a:ext cx="${width * PX}" cy="${height * PX}"/></dsp:txXfrm>`;

// A SmartArt graphic at a box in frame px: its frame on the slide, its data model's node texts, and the drawing Office
// cached of it, its shapes as given, unless a file such as LibreOffice's own writes none. The slide names the data part
// rId20 and the drawing rId21, as PowerPoint names the drawing by a relationship of the slide.
export function smartArt(
    at: [x: number, y: number, width: number, height: number],
    options: { nodes?: string[]; drawing?: string; drawingRels?: string; drawingType?: string },
): Required<Pick<SlideFixture, 'shapes' | 'rels'>> & Required<Pick<PptxFixture, 'types' | 'files'>> {
    const [x, y, width, height] = at.map((px) => px * PX);
    const relIds = `<dgm:relIds xmlns:dgm="${DGM}" r:dm="rId20" r:lo="rId22" r:qs="rId23" r:cs="rId24"/>`;
    const point = (text: string, i: number) =>
        `<dgm:pt modelId="{${i}}"><dgm:prSet phldrT="[Text]"/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></dgm:t></dgm:pt>`;
    const transition = `<dgm:pt modelId="{t}" type="parTrans" cxnId="{c}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>transition</a:t></a:r></a:p></dgm:t></dgm:pt>`;
    const extension =
        options.drawing === undefined
            ? ''
            : `<dgm:extLst><a:ext uri="${DSP}"><dsp:dataModelExt xmlns:dsp="${DSP}" relId="rId21" minVer="${DGM}"/></a:ext></dgm:extLst>`;
    const files: Record<string, string> = {
        'ppt/diagrams/data1.xml': `<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="${A}"><dgm:ptLst><dgm:pt modelId="{doc}" type="doc"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>document</a:t></a:r></a:p></dgm:t></dgm:pt>${(options.nodes ?? []).map(point).join('')}${transition}</dgm:ptLst><dgm:cxnLst/><dgm:bg/><dgm:whole/>${extension}</dgm:dataModel>`,
    };
    let types = `<Override PartName="/ppt/diagrams/data1.xml" ContentType="${DIAGRAM_DATA_TYPE}"/>`;
    if (options.drawing !== undefined) {
        files['ppt/diagrams/drawing1.xml'] =
            `<dsp:drawing xmlns:dgm="${DGM}" xmlns:dsp="${DSP}" xmlns:a="${A}" xmlns:r="${R}"><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>${options.drawing}</dsp:spTree></dsp:drawing>`;
        if (options.drawingRels) files['ppt/diagrams/_rels/drawing1.xml.rels'] = rels(options.drawingRels);
        types += `<Override PartName="/ppt/diagrams/drawing1.xml" ContentType="${options.drawingType ?? DIAGRAM_DRAWING_TYPE}"/>`;
    }
    return {
        shapes: graphicFrame(DGM, x, y, width, height, relIds),
        rels:
            rel('rId20', 'diagramData', '../diagrams/data1.xml') +
            `<Relationship Id="rId21" Type="http://schemas.microsoft.com/office/2007/relationships/diagramDrawing" Target="../diagrams/drawing1.xml"/>`,
        types,
        files,
    };
}

export const solid = (hex: string) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
export const scheme = (slot: string, transforms = '') =>
    `<a:solidFill><a:schemeClr val="${slot}">${transforms}</a:schemeClr></a:solidFill>`;

export const THEME = `<a:theme ${NS} name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Consolas"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill><a:noFill/></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const CLR_MAP =
    'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

const rels = (entries: string) =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
export const rel = (id: string, type: string, target: string, external = false) =>
    `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`;

const cSld = (shapes = '', bg?: string) =>
    `<p:cSld>${bg ? `<p:bg>${bg}</p:bg>` : ''}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld>`;

export function pptxParts(fixture: PptxFixture): Record<string, string | Uint8Array> {
    const masters = fixture.masters ?? [{}];
    const layouts = fixture.layouts ?? [{}];
    const parts: Record<string, string | Uint8Array> = {};
    const overrides: string[] = [];
    const override = (path: string, type: string) =>
        overrides.push(`<Override PartName="/${path}" ContentType="${type}"/>`);

    override('ppt/presentation.xml', fixture.mainType ?? PRESENTATION_TYPE);
    parts['_rels/.rels'] = rels(rel('rId1', 'officeDocument', 'ppt/presentation.xml'));
    const sldSz = fixture.sldSz ?? '<p:sldSz cx="12192000" cy="6858000"/>';
    const slideIds = fixture.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`).join('');
    parts['ppt/presentation.xml'] =
        fixture.presentation ??
        `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst>${sldSz}<p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
    parts['ppt/_rels/presentation.xml.rels'] = rels(
        rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml') +
            fixture.slides.map((_, i) => rel(`rId${i + 10}`, 'slide', `slides/slide${i + 1}.xml`)).join(''),
    );

    override('ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml');
    parts['ppt/theme/theme1.xml'] = fixture.theme ?? THEME;
    if (fixture.themeRels) parts['ppt/theme/_rels/theme1.xml.rels'] = rels(fixture.themeRels);
    for (const [i, master] of masters.entries()) {
        const path = `ppt/slideMasters/slideMaster${i + 1}.xml`;
        override(path, `${PML}.slideMaster+xml`);
        parts[path] =
            `<p:sldMaster ${NS}>${cSld(master.shapes, master.bg)}<p:clrMap ${master.clrMap ?? CLR_MAP}/>${master.txStyles ?? ''}</p:sldMaster>`;
        parts[`ppt/slideMasters/_rels/slideMaster${i + 1}.xml.rels`] = rels(
            rel('rId1', 'theme', '../theme/theme1.xml') + (master.rels ?? ''),
        );
    }
    for (const [i, layout] of layouts.entries()) {
        const path = `ppt/slideLayouts/slideLayout${i + 1}.xml`;
        override(path, `${PML}.slideLayout+xml`);
        parts[path] = `<p:sldLayout ${NS}${layout.attributes ?? ''}>${cSld(layout.shapes, layout.bg)}</p:sldLayout>`;
        parts[`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`] = rels(
            rel('rId1', 'slideMaster', `../slideMasters/slideMaster${layout.master ?? 1}.xml`) + (layout.rels ?? ''),
        );
    }
    for (const [i, slide] of fixture.slides.entries()) {
        const path = `ppt/slides/slide${i + 1}.xml`;
        override(path, `${PML}.slide+xml`);
        parts[path] =
            `<p:sld ${NS}${slide.attributes ?? ''}>${cSld(slide.shapes, slide.bg)}${slide.after ?? ''}</p:sld>`;
        const layout = slide.layout ?? 1;
        parts[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels(
            (layout ? rel('rId1', 'slideLayout', `../slideLayouts/slideLayout${layout}.xml`) : '') + (slide.rels ?? ''),
        );
    }
    parts['[Content_Types].xml'] =
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="emf" ContentType="image/x-emf"/>${overrides.join('')}${fixture.types ?? ''}</Types>`;
    return { ...parts, ...fixture.files };
}

export function zipParts(parts: Record<string, string | Uint8Array>): Uint8Array {
    return writeZip(Object.entries(parts).map(([name, data]) => ({ name, data })));
}

export function buildPptx(fixture: PptxFixture): Uint8Array {
    return zipParts(pptxParts(fixture));
}

// A package whose pictures are stored, each byte of PIXEL_PNG's flipped past its signature: their CRC no longer matches.
export function buildPptxWithBadPictures(fixture: PptxFixture): Uint8Array {
    const parts = pptxParts(fixture);
    const bytes = writeZip(Object.entries(parts).map(([name, data]) => ({ name, data, store: name.endsWith('.png') })));
    const head = Buffer.from(PIXEL_PNG.subarray(0, 16));
    for (let at = Buffer.from(bytes).indexOf(head); at >= 0; at = Buffer.from(bytes).indexOf(head, at + 1))
        bytes[at + 40] ^= 0xff;
    return bytes;
}

// The smallest PNG: one transparent pixel.
export const PIXEL_PNG = Uint8Array.from(
    Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
    ),
);

// How many times an element's children are read one by one, from here on.
export function countVisits(element: XmlElement): { visits: number } {
    const count = { visits: 0 };
    element.children = new Proxy(element.children, {
        get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/.test(property)) count.visits++;
            return Reflect.get(target, property, receiver);
        },
    });
    return count;
}
