// The three fixed widths a side column picks from, beside the flex main: small for navigation and tools, medium for
// a detail beside a work surface, and large for a list or a detail beside one. Column reads them by name, and a host
// that lays out around a column or draws one as a plain element, such as a properties panel, reads the number here,
// in React through useColumnWidthPx, which knows the tablet step.

import { useLayout } from './layout-context';

type FixedColumnWidth = 'small' | 'medium' | 'large';
export type ColumnWidth = 'flex' | FixedColumnWidth;

const COLUMN_WIDTH_PX = { small: 256, medium: 320, large: 400 } as const;

// A tablet beside the sidebar's 64 rail has no room for 400, so every column there that isn't small is 320.
const LARGE_ON_TABLET_PX = 320;

export function columnWidthPx(width: FixedColumnWidth, isTablet = false): number {
    return width === 'large' && isTablet ? LARGE_ON_TABLET_PX : COLUMN_WIDTH_PX[width];
}

export function useColumnWidthPx(width: FixedColumnWidth): number {
    const { isTablet } = useLayout();
    return columnWidthPx(width, isTablet);
}
