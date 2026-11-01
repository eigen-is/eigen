// The docx reader's table of contents look, which the node stores beside its levels: whether its entries show page
// numbers, from the field's \n, the leader to them, from the first entry's right tab, and each level's font, size,
// bold and italic, from Word's toc 1 to toc 6 styles. A fact that draws as the node's default is no attribute, so a
// Word table of contents with no look of its own imports as it did. The paragraph reader gives each node its
// attributes once the body is read, as the first entry may come after the paragraph the node stands in.

import { readFontSize } from '@workspace/lib/constants/fonts';
import type { TocLevelStyle } from '@workspace/lib/docs/eigendoc';
import { readTocLevelStyle, TOC_LEVEL_KEYS } from '@workspace/lib/docs/eigendoc';
import { tocStyleName } from '../../ooxml/wordml';
import { byFace, fontMark } from './docx-fonts';
import type { Reader } from './paragraphs';
import type { OpenToc } from './runs';
import type { ParaProps } from './styles';

// Whether a paragraph's right tab leads to the page number: the node's dots stand for Word's dots, dashes and lines
// alike. Undefined for a paragraph with no right tab, which says nothing of the leader.
export function entryLeads(props: ParaProps): boolean | undefined {
    return props.tabLeader === undefined ? undefined : props.tabLeader !== 'none';
}

// The node's attributes once its result is read. With no entry that has a right tab, such as an empty one's, the
// leader is the toc 1 style's.
export function tableOfContentsAttrs(reader: Reader, toc: OpenToc): Record<string, unknown> {
    const { styles } = reader;
    const leads = toc.leads ?? entryLeads(styles.para(styles.named(tocStyleName(1))?.id));
    const attrs: Record<string, unknown> = {
        levels: toc.levels,
        ...(!toc.pageNumbers && { pageNumbers: false }),
        ...(leads === false && { leader: 'none' }),
    };
    TOC_LEVEL_KEYS.forEach((key, index) => {
        const look = levelLook(reader, index + 1);
        if (look) attrs[key] = look;
    });
    return attrs;
}

// What a toc N style sets itself, not what it inherits from the Normal or the doc's defaults, through the readers a run
// goes through. A size the entry draws at anyway, the body's, is none, as a run's size is, and so is a font that maps
// to the Normal's. A bold or italic turned off draws as the body text does.
function levelLook(reader: Reader, level: number): TocLevelStyle | null {
    const rPr = reader.styles.named(tocStyleName(level))?.rPr;
    if (!rPr) return null;
    const face = byFace(' ', rPr.fonts, rPr, false)[0]?.font;
    const size = rPr.size === undefined ? undefined : readFontSize(rPr.size / 2);
    return readTocLevelStyle({
        font: face && fontMark(face, reader.fontTable, reader.normal.font),
        size: size === reader.bodySize / 2 ? undefined : size,
        bold: rPr.bold || undefined,
        italic: rPr.italic || undefined,
    });
}
