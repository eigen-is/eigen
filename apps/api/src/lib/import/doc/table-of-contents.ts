// The docx reader's table of contents look, which the node stores beside its levels. Whether its entries show page
// numbers comes from the field's \n, and the leader to them from the first entry's right tab. Each level's font, size,
// bold and italic come from Word's toc 1 to toc 6 styles. A fact that draws as the node's default is no attribute, so a
// Word table of contents with no look of its own stores only its levels. The paragraph reader gives each node its
// attributes once the body is read, as the first entry may come after the paragraph the node stands in.

import { readFontSize } from '@workspace/lib/constants/fonts';
import type { TocAttrs, TocLevelStyle } from '@workspace/lib/docs/eigendoc';
import { readTocLayout, readTocLevelStyle, TOC_LEVEL_KEYS } from '@workspace/lib/docs/eigendoc';
import { tocStyleName } from '../../ooxml/wordml';
import { fontMark, latinFace } from './docx-fonts';
import type { Reader } from './paragraphs';
import type { OpenToc } from './runs';
import type { DocxRunProps, ParaProps, Styles } from './styles';
import { MAX_CHAIN, mergeRun } from './styles';

// Whether a paragraph's right tab leads to the page number: the node's dots stand for Word's dots, dashes and lines
// alike. Undefined for a paragraph with no right tab, which says nothing of the leader.
export function entryLeads(props: ParaProps): boolean | undefined {
    return props.tabLeader === undefined ? undefined : props.tabLeader !== 'none';
}

// The node's attributes once its result is read. With no entry that has a right tab, such as an empty one's, the
// leader is the toc 1 style's.
export function tableOfContentsAttrs(reader: Reader, toc: OpenToc): Partial<TocAttrs> {
    const { styles } = reader;
    const leads = toc.leads ?? entryLeads(styles.para(styles.named(tocStyleName(1))?.id));
    const defaults = readTocLayout({});
    const leader = leads === false ? 'none' : defaults.leader;
    const attrs: Partial<TocAttrs> = {
        levels: toc.levels,
        ...(toc.pageNumbers !== defaults.pageNumbers && { pageNumbers: toc.pageNumbers }),
        ...(leader !== defaults.leader && { leader }),
    };
    for (const [index, key] of TOC_LEVEL_KEYS.entries()) {
        const look = levelLook(reader, index + 1);
        if (look) attrs[key] = look;
    }
    return attrs;
}

// What a toc N style sets, through the readers a run goes through. A size the entry draws at anyway, the body's, is
// none, as a run's size is, and so is a font that maps to the Normal's. A bold or italic turned off draws as the body
// text does.
function levelLook(reader: Reader, level: number): TocLevelStyle | null {
    const rPr = ownRun(reader.styles, tocStyleName(level));
    const face = latinFace(rPr);
    const size = rPr.size === undefined ? undefined : readFontSize(rPr.size / 2);
    return readTocLevelStyle({
        font: face && fontMark(face, reader.fontTable, reader.normal.font),
        size: size === reader.bodySize / 2 ? undefined : size,
        bold: rPr.bold || undefined,
        italic: rPr.italic || undefined,
    });
}

// A toc N style's run props along its basedOn chain, as a template may base toc 2 to toc 6 on toc 1. The chain stops
// before the Normal, and the doc's defaults are left out, as the entries draw in those anyway and they are no look.
function ownRun(styles: Styles, name: string): DocxRunProps {
    const chain: DocxRunProps[] = [];
    const seen = new Set<string>();
    for (
        let style = styles.named(name);
        style && style.id !== styles.defaultParagraph && !seen.has(style.id) && seen.size < MAX_CHAIN;
        style = styles.get(style.basedOn)
    ) {
        seen.add(style.id);
        chain.push(style.rPr);
    }
    return mergeRun(...chain.reverse());
}
