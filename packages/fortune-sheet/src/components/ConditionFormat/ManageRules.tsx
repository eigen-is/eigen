import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { X } from 'lucide-react';
import { useContext, useMemo } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { getSheetIndex, indexToColumnChar, locale } from '../../state';

type Rule = {
    conditionName: string;
    conditionValue: unknown[];
    cellrange: { row: number[]; column: number[] }[];
    format: { textColor: string | null; cellColor: string | null };
};

function formatRange(range: { row: number[]; column: number[] }): string {
    const c1 = indexToColumnChar(range.column[0]);
    const c2 = indexToColumnChar(range.column[1]);
    const r1 = range.row[0] + 1;
    const r2 = range.row[1] + 1;
    if (r1 === r2 && c1 === c2) return `${c1}${r1}`;
    return `${c1}${r1}:${c2}${r2}`;
}

function formatRanges(ranges: { row: number[]; column: number[] }[]): string {
    return ranges.map(formatRange).join(', ');
}

const RULE_LABELS: Record<string, string> = {
    greaterThan: 'Greater than',
    lessThan: 'Less than',
    between: 'Between',
    equal: 'Equal to',
    textContains: 'Text contains',
    occurrenceDate: 'Date is',
    duplicateValue: 'Duplicate values',
    top10: 'Top N',
    top10_percent: 'Top N%',
    last10: 'Bottom N',
    last10_percent: 'Bottom N%',
    aboveAverage: 'Above average',
    belowAverage: 'Below average',
};

function describeRule(rule: Rule): string {
    const label = RULE_LABELS[rule.conditionName] ?? rule.conditionName;
    const values = rule.conditionValue ?? [];

    switch (rule.conditionName) {
        case 'greaterThan':
        case 'lessThan':
        case 'equal':
        case 'textContains':
            return values[0] != null ? `${label} ${values[0]}` : label;
        case 'between':
            return values.length >= 2 ? `${label} ${values[0]} and ${values[1]}` : label;
        case 'top10':
        case 'last10':
            return values[0] != null ? `${label.replace('N', String(values[0]))}` : label;
        case 'top10_percent':
        case 'last10_percent':
            return values[0] != null ? `${label.replace('N', String(values[0]))}` : label;
        case 'occurrenceDate':
            return values[0] != null ? `${label} ${values[0]}` : label;
        case 'duplicateValue':
            return values[0] === '1' ? 'Unique values' : label;
        default:
            return label;
    }
}

function ColorSwatch({ textColor, cellColor }: { textColor: string | null; cellColor: string | null }) {
    return (
        <div
            className="w-8 h-6 rounded border border-border text-[10px] font-bold flex items-center justify-center shrink-0"
            style={{
                backgroundColor: cellColor ?? undefined,
                color: textColor ?? undefined,
            }}
        >
            Ab
        </div>
    );
}

export function ManageRules() {
    const { context, setContext } = useContext(WorkbookContext);
    const { hideDialog } = useDialog();
    const { button } = locale(context);

    const rules = useMemo(() => {
        const index = getSheetIndex(context, context.currentSheetId) as number;
        return (context.luckysheetfile[index]?.luckysheet_conditionformat_save ?? []) as Rule[];
    }, [context]);

    const deleteRule = (ruleIndex: number) => {
        setContext((ctx) => {
            const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
            const arr = ctx.luckysheetfile[index].luckysheet_conditionformat_save;
            if (arr) arr.splice(ruleIndex, 1);
        });
    };

    return (
        <div className="flex flex-col min-h-0 flex-1 gap-4">
            <DialogHeader>
                <DialogTitle>Conditional Formatting Rules</DialogTitle>
            </DialogHeader>

            {rules.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No rules on this sheet.</p>
            ) : (
                <div className="flex-1 min-h-0 border border-border rounded-md overflow-y-auto divide-y divide-border">
                    {rules.map((rule, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: rules list is stable within the dialog lifecycle
                        <div key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                            <ColorSwatch textColor={rule.format.textColor} cellColor={rule.format.cellColor} />
                            <div className="flex-1 min-w-0">
                                <div className="font-medium truncate">{describeRule(rule)}</div>
                                <div className="text-xs text-muted-foreground truncate">
                                    {formatRanges(rule.cellrange)}
                                </div>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 shrink-0"
                                onClick={() => deleteRule(i)}
                            >
                                <X className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    ))}
                </div>
            )}

            <DialogFooter>
                <Button variant="outline" size="sm" onClick={hideDialog}>
                    {button.close}
                </Button>
            </DialogFooter>
        </div>
    );
}
