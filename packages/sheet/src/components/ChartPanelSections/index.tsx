import { parseChartSpec, readChartLook } from '@workspace/lib/charts';
import { columnIndexToLabel } from '@workspace/lib/sheets';
import type { ChartLook, ChartSpec, RangeChartData } from '@workspace/lib/types/chart';
import { ChartSections } from '@workspace/ui/components/charts';
import { Input } from '@workspace/ui/components/input';
import { PropertyCheckbox, PropertyRow } from '@workspace/ui/components/properties-panel';
import type { RefObject } from 'react';
import { useState } from 'react';
import { rowIndexToLabel } from '../../engine/a1-notation';
import type { ChartRange } from '../../engine/chart-range';
import {
    CHART_RANGE_REFUSALS,
    chartRangeData,
    chartRangeOf,
    chartRangeText,
    parseChartRangeText,
} from '../../engine/chart-range';
import type { ChartPanelState } from '../../state';
import type { WorkbookInstance } from '../Workbook';

type ChartPanelSectionsProps = {
    panel: ChartPanelState;
    workbook: RefObject<WorkbookInstance | null>;
};

// The selected chart's sections in the app's panel: the shared chart and look sections, with Google's Setup (the
// data range and how it reads) inside the Chart section, where an inline chart has Edit data. A Customise change
// is one write of the chart's spec, a paint row one write of its look fields. The host's PropertyGestureContext
// makes a typed field one undo step.
export function ChartPanelSections({ panel, workbook }: ChartPanelSectionsProps) {
    const spec = parseChartSpec(panel.chart.spec);
    if (!spec) return null;
    const { data } = spec;
    const write = (next: ChartSpec) => workbook.current?.setChartSpec(panel.chart.id, next);
    const writeLook = (patch: Partial<ChartLook>) => workbook.current?.setChartLook(panel.chart.id, patch);
    return (
        <ChartSections
            spec={spec}
            onChange={write}
            look={readChartLook(panel.chart)}
            onLookChange={writeLook}
            sketchCapped={panel.sketchCapped}
            categories={panel.categories}
            seriesNames={panel.seriesNames}
        >
            {data.source === 'range' && (
                <DataRangeRows panel={panel} spec={spec} data={data} workbook={workbook} onChange={write} />
            )}
        </ChartSections>
    );
}

type DataRangeRowsProps = ChartPanelSectionsProps & {
    spec: ChartSpec;
    data: RangeChartData;
    onChange: (spec: ChartSpec) => void;
};

function DataRangeRows({ panel, spec, data, workbook, onChange }: DataRangeRowsProps) {
    const { chart, sheets, sheetId } = panel;
    const range = chartRangeOf(data);
    const text = range ? chartRangeText(range.ref, sheets, sheetId) : '';
    // While focused the field shows its draft, so a peer's write never moves the caret.
    const [draft, setDraft] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const commit = () => {
        if (draft === null || draft.trim() === text) return setError(null);
        const ref = parseChartRangeText(draft, sheets, sheetId);
        if (!ref) return setError('Enter a range such as A1:D10');
        const refusal = workbook.current?.setChartDataRange(chart.id, ref);
        setError(refusal ? CHART_RANGE_REFUSALS[refusal] : null);
    };

    // The three toggles re-derive the refs from the same block, each series keeping its style.
    const setup = (patch: Partial<ChartRange>) => {
        if (!range) return;
        const next = chartRangeData({ ...range, ...patch }, data);
        if (next) onChange({ ...spec, data: next });
    };

    const firstRow = range ? rowIndexToLabel(range.ref.row[0]) : '1';
    const firstColumn = range ? columnIndexToLabel(range.ref.column[0]) : 'A';
    const inRows = range?.seriesInRows === true;
    const toggles: { label: string; checked: boolean; patch: (checked: boolean) => Partial<ChartRange> }[] = [
        { label: 'Switch rows/columns', checked: inRows, patch: (checked) => ({ seriesInRows: checked }) },
        inRows
            ? {
                  label: `Use column ${firstColumn} as headers`,
                  checked: range?.headerColumn === true,
                  patch: (checked) => ({ headerColumn: checked }),
              }
            : {
                  label: `Use row ${firstRow} as headers`,
                  checked: range?.headerRow === true,
                  patch: (checked) => ({ headerRow: checked }),
              },
        inRows
            ? {
                  label: `Use row ${firstRow} as labels`,
                  checked: range?.headerRow === true,
                  patch: (checked) => ({ headerRow: checked }),
              }
            : {
                  label: `Use column ${firstColumn} as labels`,
                  checked: range?.headerColumn === true,
                  patch: (checked) => ({ headerColumn: checked }),
              },
    ];

    return (
        <>
            <PropertyRow label="Data range">
                <Input
                    className="h-7 text-xs"
                    aria-label="Data range"
                    aria-invalid={error !== null}
                    value={draft ?? text}
                    placeholder="A1:D10"
                    onFocus={() => setDraft(text)}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') commit();
                    }}
                    onBlur={() => {
                        commit();
                        setDraft(null);
                    }}
                />
            </PropertyRow>
            {error && <p className="text-xs text-destructive">{error}</p>}
            {toggles.map(({ label, checked, patch }) => (
                <PropertyCheckbox
                    key={label}
                    label={label}
                    checked={checked}
                    disabled={!range}
                    onCheckedChange={(next) => setup(patch(next))}
                />
            ))}
        </>
    );
}
