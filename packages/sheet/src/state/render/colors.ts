// The canvas's colors are CSS variables: the grid's in ui's globals.css, where the chart Edit data
// grid reads them too, and the theme's. A canvas can't take var(), so they are read off the canvas
// element, inside the light-pinned .eigen-paper, once per synchronous draw burst (a redraw is at
// most four freeze-region passes); the microtask flush makes a theme switch re-resolve on the next
// redraw.

export type CanvasColors = {
    gridLine: string;
    headerBackground: string;
    headerText: string;
    cellText: string;
    freezeLine: string;
    appColor: string;
    mutedForeground: string;
    background: string;
    selectionHandle: string;
};

let cached: CanvasColors | undefined;

export function canvasColors(canvas: HTMLCanvasElement): CanvasColors {
    if (cached == null) {
        const style = getComputedStyle(canvas);
        const read = (name: string) => style.getPropertyValue(name).trim();
        cached = {
            gridLine: read('--sheet-grid-line'),
            headerBackground: read('--sheet-header-background'),
            headerText: read('--sheet-header-text'),
            cellText: read('--sheet-cell-text'),
            freezeLine: read('--sheet-freeze-line'),
            appColor: read('--app-sheets-color'),
            mutedForeground: read('--muted-foreground'),
            background: read('--background'),
            selectionHandle: read('--selection-handle'),
        };
        queueMicrotask(() => {
            cached = undefined;
        });
    }
    return cached;
}
