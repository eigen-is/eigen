import type { ChartType } from '@workspace/lib/types/chart';
import type { LucideIcon } from 'lucide-react';
import { ChartBar, ChartColumn, ChartLine, ChartPie } from 'lucide-react';

// Google's names in its Insert → Chart order; a bar chart's bars are horizontal, a column chart's vertical.
export const CHART_TYPE_OPTIONS: { value: ChartType; label: string; icon: LucideIcon }[] = [
    { value: 'bar', label: 'Bar', icon: ChartBar },
    { value: 'column', label: 'Column', icon: ChartColumn },
    { value: 'line', label: 'Line', icon: ChartLine },
    { value: 'pie', label: 'Pie', icon: ChartPie },
];
