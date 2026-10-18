// In millimetres because paper is defined in them; pagePx and pageTwips return this shape in their unit. Orientation is width > height.
export type PageMargin = { top: number; right: number; bottom: number; left: number };
// differentFirstPage: page 1 takes the headerFirst and footerFirst bands instead of header and footer.
export type PageSetup = { width: number; height: number; margin: PageMargin; differentFirstPage: boolean };

const A4 = { name: 'A4', width: 210, height: 297 } as const;

// Google Docs' paper sizes in its order, portrait; a landscape page is the same paper turned.
export const PAPER_SIZES = [
    { name: 'Letter', width: 215.9, height: 279.4 },
    { name: 'Tabloid', width: 279.4, height: 431.8 },
    { name: 'Legal', width: 215.9, height: 355.6 },
    { name: 'Statement', width: 139.7, height: 215.9 },
    { name: 'Executive', width: 184.15, height: 266.7 },
    { name: 'Folio', width: 215.9, height: 330.2 },
    { name: 'A3', width: 297, height: 420 },
    A4,
    { name: 'A5', width: 148, height: 210 },
    { name: 'B4', width: 250, height: 353 },
    { name: 'B5', width: 176, height: 250 },
] as const;

export type PaperSizeName = (typeof PAPER_SIZES)[number]['name'];

export const DEFAULT_PAGE_SETUP: PageSetup = {
    width: A4.width,
    height: A4.height,
    margin: { top: 20, right: 20, bottom: 20, left: 20 },
    differentFirstPage: false,
};

// The paper a page is cut from, either way round. Within 1 mm, because Word stores the page in twips.
export function matchPaperSize({ width, height }: Pick<PageSetup, 'width' | 'height'>): PaperSizeName | undefined {
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    return PAPER_SIZES.find(
        (paper) =>
            (near(width, paper.width) && near(height, paper.height)) ||
            (near(width, paper.height) && near(height, paper.width)),
    )?.name;
}

// The doc's Y.Map root holding its page, one number in mm per key, so two people changing different margins merge.
export const PAGE_ROOT = 'page';

// Word's largest page is 22 inches. A page sized from collaborator data or a docx would otherwise reach the editor's
// layout math, WeasyPrint's @page and the docx unbounded.
const MIN_PAPER_MM = 50;
export const MAX_PAPER_MM = 558.8;
// The least text column and text height the margins leave.
export const MIN_TEXT_MM = 25;

export function pageRecord({ width, height, margin, differentFirstPage }: PageSetup) {
    return {
        width,
        height,
        marginTop: margin.top,
        marginRight: margin.right,
        marginBottom: margin.bottom,
        marginLeft: margin.left,
        differentFirstPage,
    };
}

type PageKey = Exclude<keyof ReturnType<typeof pageRecord>, 'differentFirstPage'>;

const DEFAULT_PAGE_RECORD = pageRecord(DEFAULT_PAGE_SETUP);

// The one reader of a stored page (callers pass `map.toJSON()`): any peer writes the map, so every key is checked.
// Margins that leave too little text shrink in proportion rather than reset, so a near miss stays near.
export function readPageSetup(record: Record<string, unknown>): PageSetup {
    const mm = (key: PageKey) => {
        const value = record[key];
        return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_PAGE_RECORD[key];
    };
    const paper = (key: 'width' | 'height') => Math.min(MAX_PAPER_MM, Math.max(MIN_PAPER_MM, mm(key)));
    const fit = (length: number, before: PageKey, after: PageKey) => {
        const a = Math.abs(mm(before));
        const b = Math.abs(mm(after));
        // A pair shrunk once sums to the limit only within rounding, so it must pass as it is or no read is final.
        if (a + b <= length - MIN_TEXT_MM + 1e-6) return [a, b];
        const scale = (length - MIN_TEXT_MM) / (a + b);
        return [a * scale, b * scale];
    };
    const width = paper('width');
    const height = paper('height');
    const [left, right] = fit(width, 'marginLeft', 'marginRight');
    const [top, bottom] = fit(height, 'marginTop', 'marginBottom');
    return {
        width,
        height,
        margin: { top, right, bottom, left },
        differentFirstPage: record['differentFirstPage'] === true,
    };
}

function convert(setup: PageSetup, fromMm: (mm: number) => number): PageSetup {
    const { width, height, margin } = setup;
    return {
        ...setup,
        width: fromMm(width),
        height: fromMm(height),
        margin: {
            top: fromMm(margin.top),
            right: fromMm(margin.right),
            bottom: fromMm(margin.bottom),
            left: fromMm(margin.left),
        },
    };
}

// CSS px at 96 dpi, unrounded: Docs stores a figure's width in them.
export const mmToPx = (mm: number) => (mm / 25.4) * 96;
export const pxToMm = (px: number) => (px / 96) * 25.4;

// A length as Docs' fields show it, in cm to `decimals` places, without trailing zeros.
export const cmText = (mm: number, decimals: number) => String(Math.round(mm * 10 ** (decimals - 1)) / 10 ** decimals);

// A cm field's text in mm, to 0.01 mm, or a typed 1.91 cm reads as 19.099999999999998 mm. NaN for no number.
export const readCm = (text: string) => (text.trim() === '' ? Number.NaN : Math.round(Number(text) * 1000) / 100);

export function pagePx(setup: PageSetup): PageSetup {
    return convert(setup, mmToPx);
}

// Word's twentieths of a point.
export function pageTwips(setup: PageSetup): PageSetup {
    return convert(setup, (mm) => Math.round((mm * 1440) / 25.4));
}

// The page box on screen: its margins are padding, so the content box is the text column.
export function pageBoxStyle({ width, margin }: PageSetup): { width: string; padding: string } {
    return { width: `${width}mm`, padding: `${margin.top}mm ${margin.right}mm ${margin.bottom}mm ${margin.left}mm` };
}

// The page as a stylesheet: on screen `selector` is the page box; on paper @page draws the margins, so it drops them.
export function pageStylesheet(setup: PageSetup, selector: string): string {
    const { width, padding } = pageBoxStyle(setup);
    return [
        `@page { size: ${setup.width}mm ${setup.height}mm; margin: ${padding}; }`,
        `${selector} { width: ${width}; padding: ${padding}; }`,
        `@media print { ${selector} { padding: 0; width: auto; } }`,
    ].join('\n');
}
