// The chart editor every host's panel shows: Google's Customise rows over one ChartSpec. It knows nothing of
// where the chart lives (a canvas element, a docs node, a sheet): it reads a spec and hands back a change of
// the fields a row edits, which the host applies onto the spec it stores. A typed field writes as the user goes
// inside the host's gesture (PropertyGestureContext), so a typed title is one undo step.

import { chartColor, chartPointColor, chartSeriesStyle, MAX_CHART_LABEL_LENGTH } from '@workspace/lib/charts';
import type {
    ChartAxis,
    ChartSpec,
    ChartSpecChange,
    ChartSpecOp,
    ChartStacking,
    LegendPosition,
    StoredChartSpec,
} from '@workspace/lib/types/chart';
import { LEGEND_POSITIONS } from '@workspace/lib/types/chart';
import { Button } from '@workspace/ui/components/button';
import {
    ColorRow,
    FontRow,
    MergedSelect,
    PropertyCheckbox,
    PropertyNumberInput,
    PropertyRow,
    PropertySection,
    PropertyTextInput,
} from '@workspace/ui/components/properties-panel';
import { Table } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { ChartDataDialog } from './chart-data-dialog';
import { CHART_TYPE_OPTIONS } from './chart-types';
import { fromPercent } from './percent';

const LEGEND_LABELS: Record<LegendPosition, string> = {
    top: 'Top',
    bottom: 'Bottom',
    left: 'Left',
    right: 'Right',
    none: 'None',
};
const LEGEND_OPTIONS = LEGEND_POSITIONS.map((value) => ({ value, label: LEGEND_LABELS[value] }));
// Google's words for Excel's grouping.
const STACKING_OPTIONS: { value: ChartStacking; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'stacked', label: 'Standard' },
    { value: 'percent', label: '100%' },
];

const set = (path: string[], value: unknown): ChartSpecOp => ({ op: 'set', path, value });

type ChartEditorProps = {
    spec: ChartSpec;
    // As stored, which Edit data reads for keys this build doesn't know.
    stored: StoredChartSpec;
    onChange: (change: ChartSpecChange) => void;
    // A sheet's resolved categories, which name a range chart's pie slices, and its series names, one per
    // series in the spec.
    categories?: string[];
    seriesNames?: string[];
    // A host whose double-click opens the same Edit data (Docs) opens it itself.
    onEditData?: () => void;
    // The host's actions on the chart (the canvas's Convert to shapes), at the end of the Chart section.
    children?: ReactNode;
};

export function ChartEditor({
    spec,
    stored,
    onChange,
    categories,
    seriesNames,
    onEditData,
    children,
}: ChartEditorProps) {
    const [dataOpen, setDataOpen] = useState(false);
    const { data } = spec;
    const { type } = spec.chart;
    const { x, y } = spec.axes;
    const { stacking } = spec.plots[type];
    const pie = type === 'pie';
    // A bar chart lies on its side, so its value axis is the horizontal one.
    const valueHorizontal = type === 'bar';

    // A pie draws its first series with values, whose points are its slices, so a range pie whose values were all
    // deleted has none. Range data names no categories until a sheet resolves it; without them its slices go by
    // number, as far as a slice has a color.
    const pieId = data.series.find((series) => series.values !== null)?.id;
    const colored = pieId && Object.hasOwn(spec.points, pieId) ? Object.keys(spec.points[pieId]).map(Number) : [];
    const sliceLabels = (
        data.source === 'inline'
            ? data.categories
            : (categories ?? Array.from({ length: Math.max(-1, ...colored) + 1 }, () => ''))
    ).map((category, i) => category || `Slice ${i + 1}`);

    // A 100% stack's min and max are fractions of the whole, Excel's c:min and c:max, shown and typed as
    // percents; toPrecision keeps 0.07 from showing as 7.000000000000001.
    const percent = stacking === 'percent' && (type === 'column' || type === 'bar');
    const shownBound = (bound: number | null) =>
        bound === null ? undefined : percent ? Number((bound * 100).toPrecision(12)) : bound;
    const storedBound = (typed: number) => (percent ? fromPercent(typed) : typed);

    const setBounds = (bounds: Partial<ChartAxis['scale']>) => {
        const next = { ...y.scale, ...bounds };
        // The reader drops a min at or past the max, so it would not stick.
        if (next.min !== null && next.max !== null && next.min >= next.max) return;
        onChange(Object.entries(bounds).map(([key, value]) => set(['axes', 'y', 'scale', key], value)));
    };

    const setSliceColor = (id: string, index: number, color: string | null) =>
        onChange([set(['points', id, String(index), 'color'], color)]);

    const setSeriesColor = (id: string, color: string | null) => onChange([set(['series', id, 'color'], color)]);

    // An axis's rows take their section's name, since a bar chart swaps which section holds which axis.
    type AxisName = 'Horizontal axis' | 'Vertical axis';
    const showAxisRow = (axis: AxisName, visible: boolean, onVisible: (visible: boolean) => void) => (
        <PropertyCheckbox
            label="Show axis"
            aria-label={`${axis}: Show axis`}
            checked={visible}
            onCheckedChange={onVisible}
        />
    );
    const categoryRows = (axis: AxisName) => (
        <>
            <PropertyRow label="Title">
                <PropertyTextInput
                    value={x.title.text}
                    placeholder={`${axis} title`}
                    maxLength={MAX_CHART_LABEL_LENGTH}
                    onChange={(text) => onChange([set(['axes', 'x', 'title', 'text'], text)])}
                />
            </PropertyRow>
            {showAxisRow(axis, x.visible, (visible) => onChange([set(['axes', 'x', 'visible'], visible)]))}
            <PropertyCheckbox
                label="Reverse axis order"
                aria-label={`${axis}: Reverse axis order`}
                checked={x.scale.reversed}
                onCheckedChange={(reversed) => onChange([set(['axes', 'x', 'scale', 'reversed'], reversed)])}
            />
        </>
    );

    const valueRows = (axis: AxisName) => (
        <>
            <PropertyRow label="Title">
                <PropertyTextInput
                    value={y.title.text}
                    placeholder={`${axis} title`}
                    maxLength={MAX_CHART_LABEL_LENGTH}
                    onChange={(text) => onChange([set(['axes', 'y', 'title', 'text'], text)])}
                />
            </PropertyRow>
            {showAxisRow(axis, y.visible, (visible) => onChange([set(['axes', 'y', 'visible'], visible)]))}
            <PropertyRow label="Min">
                <PropertyNumberInput
                    value={shownBound(y.scale.min)}
                    placeholder="Auto"
                    onChange={(min) => setBounds({ min: storedBound(min) })}
                    onClear={() => setBounds({ min: null })}
                />
            </PropertyRow>
            <PropertyRow label="Max">
                <PropertyNumberInput
                    value={shownBound(y.scale.max)}
                    placeholder="Auto"
                    onChange={(max) => setBounds({ max: storedBound(max) })}
                    onClear={() => setBounds({ max: null })}
                />
            </PropertyRow>
            <PropertyCheckbox
                label="Gridlines"
                aria-label={`${axis}: Gridlines`}
                checked={y.gridlines.visible}
                onCheckedChange={(visible) => onChange([set(['axes', 'y', 'gridlines', 'visible'], visible)])}
            />
        </>
    );

    // Excel's bar chart reads reversed by default, so its direction would turn a column chart right to left. Column and
    // bar share their stacking, so a switch between them keeps it.
    const setType = (next: ChartSpec['chart']['type']) => {
        const bars = (t: string) => t === 'column' || t === 'bar';
        onChange([
            set(['chart', 'type'], next),
            ...((next === 'bar') === valueHorizontal ? [] : [set(['axes', 'x', 'scale', 'reversed'], false)]),
            ...(bars(type) && bars(next) && spec.plots[next].stacking !== stacking
                ? [set(['plots', next, 'stacking'], stacking)]
                : []),
        ]);
    };

    return (
        <>
            <PropertySection title="Chart">
                <PropertyRow label="Type">
                    <MergedSelect value={type} options={CHART_TYPE_OPTIONS} onChange={setType} />
                </PropertyRow>
                {(type === 'column' || type === 'bar') && (
                    <PropertyRow label="Stacking">
                        <MergedSelect
                            value={stacking}
                            options={STACKING_OPTIONS}
                            onChange={(next) =>
                                // Shares and raw values don't carry over: a raw max of 100 would be 10,000%.
                                onChange(
                                    (next === 'percent') === percent
                                        ? [set(['plots', type, 'stacking'], next)]
                                        : [
                                              set(['plots', type, 'stacking'], next),
                                              set(['axes', 'y', 'scale', 'min'], null),
                                              set(['axes', 'y', 'scale', 'max'], null),
                                          ],
                                )
                            }
                        />
                    </PropertyRow>
                )}
                <PropertyRow label="Title">
                    <PropertyTextInput
                        value={spec.title.text}
                        placeholder="Chart title"
                        maxLength={MAX_CHART_LABEL_LENGTH}
                        onChange={(text) => onChange([set(['title', 'text'], text)])}
                    />
                </PropertyRow>
                <PropertyRow label="Legend">
                    <MergedSelect
                        value={spec.legend.position}
                        options={LEGEND_OPTIONS}
                        onChange={(position) => onChange([set(['legend', 'position'], position)])}
                    />
                </PropertyRow>
                <FontRow
                    value={spec.chart.fontFamily}
                    onChange={(fontFamily) => onChange([set(['chart', 'fontFamily'], fontFamily)])}
                />
                {data.source === 'inline' && (
                    <>
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                            onClick={onEditData ?? (() => setDataOpen(true))}
                        >
                            <Table /> Edit data
                        </Button>
                        {!onEditData && (
                            <ChartDataDialog
                                spec={{ ...spec, data }}
                                stored={stored}
                                open={dataOpen}
                                onOpenChange={setDataOpen}
                                onSave={onChange}
                            />
                        )}
                    </>
                )}
                {children}
            </PropertySection>

            {!pie && (
                <PropertySection title="Horizontal axis">
                    {valueHorizontal ? valueRows('Horizontal axis') : categoryRows('Horizontal axis')}
                </PropertySection>
            )}
            {!pie && (
                <PropertySection title="Vertical axis">
                    {valueHorizontal ? categoryRows('Vertical axis') : valueRows('Vertical axis')}
                </PropertySection>
            )}

            {pie ? (
                <PropertySection title="Slices">
                    {pieId &&
                        sliceLabels.map((label, i) => {
                            const color = chartPointColor(spec, pieId, i);
                            return (
                                <ColorRow
                                    key={i}
                                    label={label}
                                    value={color ?? chartColor(i)}
                                    onChange={(picked) => setSliceColor(pieId, i, picked)}
                                    automatic={{ active: color === null, onReset: () => setSliceColor(pieId, i, null) }}
                                />
                            );
                        })}
                </PropertySection>
            ) : (
                <PropertySection title="Series">
                    {/* A range series whose values were deleted draws nothing, so it has no row. */}
                    {data.series.map((series, i) => {
                        if (series.values === null) return null;
                        const { color } = chartSeriesStyle(spec, series.id);
                        return (
                            <ColorRow
                                key={series.id}
                                label={
                                    seriesNames?.[i] ||
                                    (typeof series.name === 'string' && series.name) ||
                                    `Series ${i + 1}`
                                }
                                value={color ?? chartColor(i)}
                                onChange={(picked) => setSeriesColor(series.id, picked)}
                                automatic={{ active: color === null, onReset: () => setSeriesColor(series.id, null) }}
                            />
                        );
                    })}
                </PropertySection>
            )}
        </>
    );
}
