// The docs page, in millimetres because paper is defined in them. Orientation is width > height.
export type PageMargin = { top: number; right: number; bottom: number; left: number };
export type PageSetup = { width: number; height: number; margin: PageMargin };

export const DEFAULT_PAGE_SETUP: PageSetup = {
    width: 210,
    height: 297,
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

export function pageAtRule(setup: PageSetup): string {
    return `@page { size: ${setup.width}mm ${setup.height}mm; margin: ${pageBoxStyle(setup).padding}; }`;
}
