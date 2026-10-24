// The chart editor every host's panel shows: Google's Customise rows over one ChartSpec. It knows nothing of
// where the chart lives (a canvas element, a docs node, a sheet): it reads a spec and hands back a change of
// the fields a row edits, which the host applies onto the spec it stores. A typed field writes as the user goes
// inside the host's gesture (PropertyGestureContext), so a typed title is one undo step.

import { chartColor, MAX_CHART_LABEL_LENGTH } from '@workspace/lib/charts';
import type {
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
    const { type, data, valueAxis, categoryAxis } = spec;
    const pie = type === 'pie';
    // A bar chart lies on its side, so its value axis is the horizontal one.
    const valueHorizontal = type === 'bar';

    // Range data names no categories until a sheet resolves it; without them its slices go by number.
    const sliceLabels = (
        data.source === 'inline' ? data.categories : (categories ?? spec.sliceColors.map(() => ''))
    ).map((category, i) => category || `Slice ${i + 1}`);
    const sliceColors = sliceLabels.map((_, i) => spec.sliceColors[i] ?? null);

    // A 100% stack's min and max are fractions of the whole, Excel's c:min and c:max, shown and typed as
    // percents; toPrecision keeps 0.07 from showing as 7.000000000000001.
    const percent = spec.stacking === 'percent' && (type === 'column' || type === 'bar');
    const shownBound = (bound: number | null) =>
        bound === null ? undefined : percent ? Number((bound * 100).toPrecision(12)) : bound;
    const storedBound = (typed: number) => (percent ? fromPercent(typed) : typed);

    const setValueAxis = (patch: Partial<ChartSpec['valueAxis']>) => {
        const next = { ...valueAxis, ...patch };
        // The reader drops a min at or past the max, so it would not stick.
        if (next.min !== null && next.max !== null && next.min >= next.max) return;
        onChange(Object.entries(patch).map(([key, value]) => set(['valueAxis', key], value)));
    };

    const setSliceColor = (index: number, color: string | null) =>
        onChange([
            set(
                ['sliceColors'],
                sliceColors.map((c, i) => (i === index ? color : c)),
            ),
        ]);

    // The list lands on the stored series by id, so what a newer build keeps on a series stays.
    const setSeriesColor = (index: number, color: string | null) =>
        onChange([
            set(
                ['data', 'series'],
                data.series.map((s, i) => (i === index ? { ...s, color } : s)),
            ),
        ]);

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
    const setCategoryAxis = (patch: Partial<ChartSpec['categoryAxis']>) =>
        onChange(Object.entries(patch).map(([key, value]) => set(['categoryAxis', key], value)));

    const categoryRows = (axis: AxisName) => (
        <>
            <PropertyRow label="Title">
                <PropertyTextInput
                    value={categoryAxis.title}
                    placeholder={`${axis} title`}
                    maxLength={MAX_CHART_LABEL_LENGTH}
                    onChange={(title) => setCategoryAxis({ title })}
                />
            </PropertyRow>
            {showAxisRow(axis, categoryAxis.visible, (visible) => setCategoryAxis({ visible }))}
            <PropertyCheckbox
                label="Reverse axis order"
                aria-label={`${axis}: Reverse axis order`}
                checked={categoryAxis.reversed}
                onCheckedChange={(reversed) => setCategoryAxis({ reversed })}
            />
        </>
    );

    const valueRows = (axis: AxisName) => (
        <>
            <PropertyRow label="Title">
                <PropertyTextInput
                    value={valueAxis.title}
                    placeholder={`${axis} title`}
                    maxLength={MAX_CHART_LABEL_LENGTH}
                    onChange={(title) => setValueAxis({ title })}
                />
            </PropertyRow>
            {showAxisRow(axis, valueAxis.visible, (visible) => setValueAxis({ visible }))}
            <PropertyRow label="Min">
                <PropertyNumberInput
                    value={shownBound(valueAxis.min)}
                    placeholder="Auto"
                    onChange={(min) => setValueAxis({ min: storedBound(min) })}
                    onClear={() => setValueAxis({ min: null })}
                />
            </PropertyRow>
            <PropertyRow label="Max">
                <PropertyNumberInput
                    value={shownBound(valueAxis.max)}
                    placeholder="Auto"
                    onChange={(max) => setValueAxis({ max: storedBound(max) })}
                    onClear={() => setValueAxis({ max: null })}
                />
            </PropertyRow>
            <PropertyCheckbox
                label="Gridlines"
                aria-label={`${axis}: Gridlines`}
                checked={valueAxis.gridlines}
                onCheckedChange={(gridlines) => setValueAxis({ gridlines })}
            />
        </>
    );

    return (
        <>
            <PropertySection title="Chart">
                <PropertyRow label="Type">
                    <MergedSelect
                        value={type}
                        options={CHART_TYPE_OPTIONS}
                        onChange={(next) =>
                            // Excel's bar chart reads reversed by default, so its direction would turn a
                            // column chart right to left.
                            onChange(
                                (next === 'bar') === (type === 'bar')
                                    ? [set(['type'], next)]
                                    : [set(['type'], next), set(['categoryAxis', 'reversed'], false)],
                            )
                        }
                    />
                </PropertyRow>
                {(type === 'column' || type === 'bar') && (
                    <PropertyRow label="Stacking">
                        <MergedSelect
                            value={spec.stacking}
                            options={STACKING_OPTIONS}
                            onChange={(stacking) =>
                                // Shares and raw values don't carry over: a raw max of 100 would be 10,000%.
                                onChange(
                                    (stacking === 'percent') === (spec.stacking === 'percent')
                                        ? [set(['stacking'], stacking)]
                                        : [
                                              set(['stacking'], stacking),
                                              set(['valueAxis', 'min'], null),
                                              set(['valueAxis', 'max'], null),
                                          ],
                                )
                            }
                        />
                    </PropertyRow>
                )}
                <PropertyRow label="Title">
                    <PropertyTextInput
                        value={spec.title}
                        placeholder="Chart title"
                        maxLength={MAX_CHART_LABEL_LENGTH}
                        onChange={(title) => onChange([set(['title'], title)])}
                    />
                </PropertyRow>
                <PropertyRow label="Legend">
                    <MergedSelect
                        value={spec.legend}
                        options={LEGEND_OPTIONS}
                        onChange={(legend) => onChange([set(['legend'], legend)])}
                    />
                </PropertyRow>
                <FontRow
                    value={spec.fontFamily}
                    onChange={(fontFamily) => onChange([set(['fontFamily'], fontFamily)])}
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
                    {sliceLabels.map((label, i) => (
                        <ColorRow
                            key={i}
                            label={label}
                            value={sliceColors[i] ?? chartColor(i)}
                            onChange={(color) => setSliceColor(i, color)}
                            automatic={{ active: sliceColors[i] === null, onReset: () => setSliceColor(i, null) }}
                        />
                    ))}
                </PropertySection>
            ) : (
                <PropertySection title="Series">
                    {/* A range series whose values were deleted draws nothing, so it has no row. */}
                    {data.series.map((series, i) =>
                        series.values === null ? null : (
                            <ColorRow
                                key={i}
                                label={
                                    seriesNames?.[i] ||
                                    (typeof series.name === 'string' && series.name) ||
                                    `Series ${i + 1}`
                                }
                                value={series.color ?? chartColor(i)}
                                onChange={(color) => setSeriesColor(i, color)}
                                automatic={{
                                    active: series.color === null,
                                    onReset: () => setSeriesColor(i, null),
                                }}
                            />
                        ),
                    )}
                </PropertySection>
            )}
        </>
    );
}
