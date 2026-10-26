// The chart types as the menus list them, with a name and an icon each: the editor's Type switch and every app's
// Insert → Chart. A type the spec gains is a type error here until it has a row.

import type { ChartType } from '@workspace/lib/types/chart';
import { CHART_TYPES } from '@workspace/lib/types/chart';
import type { LucideIcon } from 'lucide-react';
import { ChartBar, ChartColumn, ChartLine, ChartPie } from 'lucide-react';

// Google's names in its Insert → Chart order; a bar chart's bars are horizontal, a column chart's vertical.
const CHART_TYPE_ROWS: Record<ChartType, { label: string; icon: LucideIcon }> = {
    bar: { label: 'Bar', icon: ChartBar },
    column: { label: 'Column', icon: ChartColumn },
    line: { label: 'Line', icon: ChartLine },
    pie: { label: 'Pie', icon: ChartPie },
};

const ORDER = Object.keys(CHART_TYPE_ROWS);

export const CHART_TYPE_OPTIONS: { value: ChartType; label: string; icon: LucideIcon }[] = [...CHART_TYPES]
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
    .map((value) => ({ value, ...CHART_TYPE_ROWS[value] }));
