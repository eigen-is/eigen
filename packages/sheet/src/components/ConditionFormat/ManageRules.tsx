import type { ConditionalFormatRule, DefaultConditionalFormatRule, SingleRange } from '@workspace/lib/sheets';
import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { X } from 'lucide-react';
import { useContext, useMemo } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { getSheetIndex, indexToColumnChar } from '../../state';

function formatRange(range: SingleRange): string {
    const c1 = indexToColumnChar(range.column[0]);
    const c2 = indexToColumnChar(range.column[1]);
    const r1 = range.row[0] + 1;
    const r2 = range.row[1] + 1;
    if (r1 === r2 && c1 === c2) return `${c1}${r1}`;
    return `${c1}${r1}:${c2}${r2}`;
}

function formatRanges(ranges: SingleRange[]): string {
    return ranges.map(formatRange).join(', ');
}

const RULE_LABELS: Record<string, string> = {
    greaterThan: 'Greater than',
    greaterThanOrEqual: 'Greater than or equal to',
    lessThan: 'Less than',
    lessThanOrEqual: 'Less than or equal to',
    between: 'Between',
    notBetween: 'Not between',
    equal: 'Equal to',
    notEqual: 'Not equal to',
    textContains: 'Text contains',
    occurrenceDate: 'Date is',
    duplicateValue: 'Duplicate values',
    top10: 'Top N',
    top10_percent: 'Top N%',
    last10: 'Bottom N',
    last10_percent: 'Bottom N%',
    aboveAverage: 'Above average',
    belowAverage: 'Below average',
    formula: 'Custom formula',
};

function describeDefaultRule(rule: DefaultConditionalFormatRule): string {
    const label = RULE_LABELS[rule.conditionName] ?? rule.conditionName;
    const values = rule.conditionValue ?? [];

    switch (rule.conditionName) {
        case 'greaterThan':
        case 'greaterThanOrEqual':
        case 'lessThan':
        case 'lessThanOrEqual':
        case 'equal':
        case 'notEqual':
        case 'textContains':
        case 'occurrenceDate':
            return values[0] != null ? `${label} ${values[0]}` : label;
        case 'between':
        case 'notBetween':
            return values.length >= 2 ? `${label} ${values[0]} and ${values[1]}` : label;
        case 'top10':
        case 'top10_percent':
        case 'last10':
        case 'last10_percent':
            return values[0] != null ? label.replace('N', String(values[0])) : label;
        case 'duplicateValue':
            return values[0] === '1' ? 'Unique values' : label;
        default:
            return label;
    }
}

function describeRule(rule: ConditionalFormatRule): string {
    switch (rule.type) {
        case 'colorGradation':
            return 'Color scale';
        case 'dataBar':
            return 'Data bar';
        case 'icons':
            return 'Icon set';
        case 'default':
            return describeDefaultRule(rule);
    }
}

function RuleSwatch({ rule }: { rule: ConditionalFormatRule }) {
    if (rule.type === 'default') {
        return (
            <div
                className="w-8 h-6 rounded border border-border text-[10px] font-medium flex items-center justify-center shrink-0"
                style={{
                    backgroundColor: rule.format.cellColor ?? undefined,
                    color: rule.format.textColor ?? undefined,
                }}
            >
                Ab
            </div>
        );
    }
    if (rule.type === 'colorGradation') {
        return (
            <div
                className="w-8 h-6 rounded border border-border shrink-0"
                style={{ background: `linear-gradient(to right, ${rule.format.join(', ')})` }}
            />
        );
    }
    if (rule.type === 'dataBar') {
        const [color] = rule.format;
        return (
            <div className="w-8 h-6 rounded border border-border shrink-0 flex items-center px-0.5">
                <div className="h-3 w-5 rounded-sm" style={{ backgroundColor: color }} />
            </div>
        );
    }
    return <div className="w-8 h-6 rounded border border-border shrink-0" />;
}

export function ManageRules() {
    const { context, setContext } = useContext(WorkbookContext);
    const { hideDialog } = useDialog();

    const rules = useMemo(() => {
        const index = getSheetIndex(context, context.currentSheetId) as number;
        return context.sheets[index]?.conditionalFormatRules ?? [];
    }, [context]);

    const deleteRule = (ruleIndex: number) => {
        setContext((ctx) => {
            const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
            const arr = ctx.sheets[index].conditionalFormatRules;
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
                            <RuleSwatch rule={rule} />
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
                    Close
                </Button>
            </DialogFooter>
        </div>
    );
}
