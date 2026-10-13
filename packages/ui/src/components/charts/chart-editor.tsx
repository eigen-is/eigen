// The chart editor every host's panel shows: Google's Customise rows over one ChartSpec. It knows nothing of
// where the chart lives (a canvas element, a docs node, a sheet): it reads a spec and hands back the next
// one, and the host writes it. A typed field writes as the user goes inside the host's gesture
// (PropertyGestureContext), so a typed title is one undo step.

import { chartColor, MAX_CHART_LABEL_LENGTH } from '@workspace/lib/charts';
import { type ChartSpec, type ChartStacking, LEGEND_POSITIONS, type LegendPosition } from '@workspace/lib/types/chart';
import { Checkbox } from '@workspace/ui/components/checkbox';
import {
    ColorRow,
    FontRow,
    MergedSelect,
    PropertyNumberInput,
    PropertyRow,
    PropertySection,
    PropertyTextInput,
} from '@workspace/ui/components/properties-panel';
import type { ReactNode } from 'react';
import { CHART_TYPE_OPTIONS } from './chart-types';

const LEGEND_LABELS: Record<LegendPosition, string> = {
    top: 'Top',
    bottom: 'Bottom',
    left: 'Left',
    right: 'Right',
    none: 'None',
};
const LEGEND_OPTIONS = LEGEND_POSITIONS.map((value) => ({ value, label: LEGEND_LABELS[value] }));
const STACKING_OPTIONS: { value: ChartStacking; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'stacked', label: 'Stacked' },
    { value: 'percent', label: '100% stacked' },
];

type ChartEditorProps = {
    spec: ChartSpec;
    onChange: (spec: ChartSpec) => void;
    // A sheet's resolved categories, which name a range chart's pie slices, and its series names, one per
    // series in the spec.
    categories?: string[];
    seriesNames?: string[];
    // The host's actions on the chart (the canvas's Edit data), at the end of the Chart section.
    children?: ReactNode;
};

export function ChartEditor({ spec, onChange, categories, seriesNames, children }: ChartEditorProps) {
    const { type, data, valueAxis, categoryAxis } = spec;
    const pie = type === 'pie';
    // A bar chart lies on its side, so its value axis is the horizontal one.
    const valueHorizontal = type === 'bar';

    // Range data names no categories until a sheet resolves it; without them its slices go by number.
    const sliceLabels = (
        data.source === 'inline' ? data.categories : (categories ?? spec.sliceColors.map(() => ''))
    ).map((category, i) => category || `Slice ${i + 1}`);
    const sliceColors = sliceLabels.map((_, i) => spec.sliceColors[i] ?? null);

    const setValueAxis = (patch: Partial<ChartSpec['valueAxis']>) => {
        const next = { ...valueAxis, ...patch };
        // The reader drops a min at or past the max, so it would not stick.
        if (next.min !== null && next.max !== null && next.min >= next.max) return;
        onChange({ ...spec, valueAxis: next });
    };

    const setSliceColor = (index: number, color: string | null) =>
        onChange({ ...spec, sliceColors: sliceColors.map((c, i) => (i === index ? color : c)) });

    const setSeriesColor = (index: number, color: string | null) => {
        const recolor = <S extends { color: string | null }>(series: S[]) =>
            series.map((s, i) => (i === index ? { ...s, color } : s));
        onChange({
            ...spec,
            data:
                data.source === 'inline'
                    ? { ...data, series: recolor(data.series) }
                    : { ...data, series: recolor(data.series) },
        });
    };

    const categoryTitle = (placeholder: string) => (
        <PropertyRow label="Title">
            <PropertyTextInput
                value={categoryAxis.title}
                placeholder={placeholder}
                maxLength={MAX_CHART_LABEL_LENGTH}
                onChange={(title) => onChange({ ...spec, categoryAxis: { title } })}
            />
        </PropertyRow>
    );

    const valueRows = (placeholder: string) => (
        <>
            <PropertyRow label="Title">
                <PropertyTextInput
                    value={valueAxis.title}
                    placeholder={placeholder}
                    maxLength={MAX_CHART_LABEL_LENGTH}
                    onChange={(title) => setValueAxis({ title })}
                />
            </PropertyRow>
            <PropertyRow label="Min">
                <PropertyNumberInput
                    value={valueAxis.min ?? undefined}
                    placeholder="Auto"
                    onChange={(min) => setValueAxis({ min })}
                    onClear={() => setValueAxis({ min: null })}
                />
            </PropertyRow>
            <PropertyRow label="Max">
                <PropertyNumberInput
                    value={valueAxis.max ?? undefined}
                    placeholder="Auto"
                    onChange={(max) => setValueAxis({ max })}
                    onClear={() => setValueAxis({ max: null })}
                />
            </PropertyRow>
            <PropertyRow label="Gridlines">
                <Checkbox
                    aria-label="Gridlines"
                    checked={valueAxis.gridlines}
                    onCheckedChange={(checked) => setValueAxis({ gridlines: checked === true })}
                />
            </PropertyRow>
        </>
    );

    return (
        <>
            <PropertySection title="Chart">
                <PropertyRow label="Type">
                    <MergedSelect
                        value={type}
                        options={CHART_TYPE_OPTIONS}
                        onChange={(next) => onChange({ ...spec, type: next })}
                    />
                </PropertyRow>
                {(type === 'column' || type === 'bar') && (
                    <PropertyRow label="Stacking">
                        <MergedSelect
                            value={spec.stacking}
                            options={STACKING_OPTIONS}
                            onChange={(stacking) => onChange({ ...spec, stacking })}
                        />
                    </PropertyRow>
                )}
                <PropertyRow label="Title">
                    <PropertyTextInput
                        value={spec.title}
                        placeholder="Chart title"
                        maxLength={MAX_CHART_LABEL_LENGTH}
                        onChange={(title) => onChange({ ...spec, title })}
                    />
                </PropertyRow>
                <PropertyRow label="Legend">
                    <MergedSelect
                        value={spec.legend}
                        options={LEGEND_OPTIONS}
                        onChange={(legend) => onChange({ ...spec, legend })}
                    />
                </PropertyRow>
                <FontRow value={spec.fontFamily} onChange={(fontFamily) => onChange({ ...spec, fontFamily })} />
                {children}
            </PropertySection>

            {!pie && (
                <PropertySection title="Horizontal axis">
                    {valueHorizontal ? valueRows('Horizontal axis title') : categoryTitle('Horizontal axis title')}
                </PropertySection>
            )}
            {!pie && (
                <PropertySection title="Vertical axis">
                    {valueHorizontal ? categoryTitle('Vertical axis title') : valueRows('Vertical axis title')}
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
