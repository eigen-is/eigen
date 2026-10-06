// In millimetres because paper is defined in them; pagePx and pageTwips return this shape in their unit. Orientation is width > height.
export type PageMargin = { top: number; right: number; bottom: number; left: number };
export type PageSetup = { width: number; height: number; margin: PageMargin };

// Portrait sizes; a landscape page is the same paper turned.
export const PAPER_SIZES = [{ name: 'A4', width: 210, height: 297 }] as const;

const [A4] = PAPER_SIZES;

export const DEFAULT_PAGE_SETUP: PageSetup = {
    width: A4.width,
    height: A4.height,
    margin: { top: 20, right: 20, bottom: 20, left: 20 },
};

function convert({ width, height, margin }: PageSetup, fromMm: (mm: number) => number): PageSetup {
    return {
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

// CSS px at 96 dpi.
export function pagePx(setup: PageSetup): PageSetup {
    return convert(setup, (mm) => (mm * 96) / 25.4);
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
