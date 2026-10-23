import { parseChartSpec, readChartLook } from '@workspace/lib/charts';
import { columnIndexToLabel } from '@workspace/lib/sheets';
import type { ChartLook, ChartSpec, RangeChartData } from '@workspace/lib/types/chart';
import { parseFill, serializeFill } from '@workspace/lib/vector';
import { ChartEditor } from '@workspace/ui/components/charts';
import { Input } from '@workspace/ui/components/input';
import {
    PaintSections,
    PropertiesPanel,
    PropertyCheckbox,
    PropertyGestureContext,
    PropertyRow,
    PropertySection,
} from '@workspace/ui/components/properties-panel';
import { type ReactNode, type RefObject, useState } from 'react';
import { rowIndexToLabel } from '../../engine/a1-notation';
import {
    CHART_RANGE_REFUSALS,
    type ChartRange,
    chartRangeData,
    chartRangeOf,
    chartRangeText,
    parseChartRangeText,
} from '../../engine/chart-range';
import type { ChartEditorState } from '../../state';
import type { WorkbookInstance } from '../Workbook';

type ChartEditorPanelProps = {
    editor: ChartEditorState;
    workbook: RefObject<WorkbookInstance | null>;
    // The app's rows after the chart's own: the Transform section a selected chart shows without its editor.
    children?: ReactNode;
};

// Google's Chart editor: Setup (the data range and how it reads) over the shared Customise rows, then the
// look's paint rows. A Customise change is one write of the chart's spec, a paint row one write of its look
// fields, and a typed field one undo step for the whole edit.
export function ChartEditorPanel({ editor, workbook, children }: ChartEditorPanelProps) {
    const spec = parseChartSpec(editor.chart.spec);
    if (!spec) return null;
    const { data } = spec;
    const look = readChartLook(editor.chart);
    const write = (next: ChartSpec) => workbook.current?.setChartSpec(editor.chart.id, next);
    const writeLook = (patch: Partial<ChartLook>) => workbook.current?.setChartLook(editor.chart.id, patch);
    const beginGesture = () => workbook.current?.beginGesture() ?? (() => {});
    return (
        <PropertiesPanel title="Chart editor">
            <PropertyGestureContext.Provider value={beginGesture}>
                {data.source === 'range' && (
                    <SetupSection editor={editor} spec={spec} data={data} workbook={workbook} onChange={write} />
                )}
                <ChartEditor
                    spec={spec}
                    onChange={write}
                    categories={editor.categories}
                    seriesNames={editor.seriesNames}
                />
                <PaintSections
                    fill={look.fill}
                    fillStyle={parseFill(look.fill).style}
                    marksHatch
                    strokeColor={look.strokeColor}
                    strokeWidth={look.strokeWidth}
                    strokeStyle={look.strokeStyle}
                    strokeOptional
                    roughness={look.roughness}
                    color={look.color}
                    sketchCapped={editor.sketchCapped}
                    onFill={(next) => writeLook({ fill: serializeFill(next(parseFill(look.fill))) })}
                    onChange={writeLook}
                />
                {children}
            </PropertyGestureContext.Provider>
        </PropertiesPanel>
    );
}

type SetupSectionProps = ChartEditorPanelProps & {
    spec: ChartSpec;
    data: RangeChartData;
    onChange: (spec: ChartSpec) => void;
};

function SetupSection({ editor, spec, data, workbook, onChange }: SetupSectionProps) {
    const { chart, sheets, sheetId } = editor;
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
        const next = chartRangeData({ ...range, ...patch }, data.series);
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
        <PropertySection title="Setup">
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
        </PropertySection>
    );
}
