// The dialog for one conditional-format rule, such as "Greater than" or "Top 10", opened from the Format menu. It
// holds the rule's value and colors, and on OK it checks them with conditionRuleError: a refused value keeps the
// dialog open with the reason under the field, and a good one goes to setConditionRules. RULE_COPY names each rule
// once, so this dialog and the places that list rules, such as the Format menu, show the same words.

import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { FieldError } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { ColorPicker } from '@workspace/ui/components/media';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import type { ReactNode } from 'react';
import { useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialogProps } from '../../hooks/useDialog';
import type { ConditionRulesProps } from '../../state';
import { conditionRuleError, setConditionRules } from '../../state';

export type ConditionRuleType =
    | 'greaterThan'
    | 'lessThan'
    | 'between'
    | 'equal'
    | 'textContains'
    | 'occurrenceDate'
    | 'duplicateValue'
    | 'top10'
    | 'top10_percent'
    | 'last10'
    | 'last10_percent'
    | 'aboveAverage'
    | 'belowAverage';

// Named once for the menu, this dialog and the Manage-rules list; a few labels
// carry their connective ("Equal to") because Manage-rules appends the value.
export const RULE_COPY: Record<ConditionRuleType, { label: string; description: string }> = {
    greaterThan: { label: 'Greater than', description: 'Format cells greater than' },
    lessThan: { label: 'Less than', description: 'Format cells smaller than' },
    between: { label: 'Between', description: 'Format cells with values between' },
    equal: { label: 'Equal to', description: 'Format cells equal to' },
    textContains: { label: 'Text contains', description: 'Format cells containing the following text' },
    occurrenceDate: { label: 'Date is', description: 'Format cells containing the following dates' },
    duplicateValue: {
        label: 'Duplicate value',
        description: 'Format cells containing the following types of values',
    },
    top10: { label: 'Top 10', description: 'Format the cells with the highest value' },
    top10_percent: { label: 'Top 10%', description: 'Format the cells with the highest value' },
    last10: { label: 'Last 10', description: 'Format the cells with the smallest value' },
    last10_percent: { label: 'Last 10%', description: 'Format the cells with the smallest value' },
    aboveAverage: { label: 'Above average', description: 'Format cells above average' },
    belowAverage: { label: 'Below average', description: 'Format cells below average' },
};

export function ConditionRules({ type }: { type: ConditionRuleType }) {
    const { context, setContext } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();
    const { label, description } = RULE_COPY[type];
    const [rule, setRule] = useState<ConditionRulesProps>({
        rulesType: type,
        rulesValue: '',
        textColor: { check: false, color: '#009966' },
        cellColor: { check: true, color: '#d0fae5' },
        betweenValue: { value1: '', value2: '' },
        dateValue: '',
        repeatValue: '0',
        projectValue: '10',
    });
    // The reason the last OK was refused, until the next edit.
    const [error, setError] = useState<string | null>(null);
    const edit = (change: Partial<ConditionRulesProps>) => {
        setRule((prev) => ({ ...prev, ...change }));
        setError(null);
    };

    const valueField = ruleValueField(type, rule, edit);

    return (
        <FormDialog {...dialogProps} title={label} description={description} size="md">
            <FormDialogForm
                submitLabel="OK"
                onSubmit={() => {
                    const refusal = conditionRuleError(context, rule);
                    if (refusal) {
                        setError(refusal);
                        return false;
                    }
                    setContext((ctx) => setConditionRules(ctx, rule));
                }}
            >
                {valueField && (
                    <div>
                        {valueField}
                        {error && <FieldError className="mt-1.5">{error}</FieldError>}
                    </div>
                )}

                <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">Set as:</p>
                    <div className="rounded-md border p-3 space-y-3">
                        <ColorChoice
                            id="checkTextColor"
                            label="Text color"
                            choice={rule.textColor}
                            onChange={(textColor) => edit({ textColor })}
                        />
                        <ColorChoice
                            id="checkCellColor"
                            label="Cell color"
                            choice={rule.cellColor}
                            onChange={(cellColor) => edit({ cellColor })}
                        />
                    </div>
                </div>
            </FormDialogForm>
        </FormDialog>
    );
}

// The field a rule's value is typed or picked in, or null for a rule that takes none, such as Above average.
function ruleValueField(
    type: ConditionRuleType,
    rule: ConditionRulesProps,
    edit: (change: Partial<ConditionRulesProps>) => void,
): ReactNode {
    switch (type) {
        case 'greaterThan':
        case 'lessThan':
        case 'equal':
        case 'textContains':
            return (
                <Input
                    aria-label="Value"
                    value={rule.rulesValue}
                    onChange={(e) => edit({ rulesValue: e.target.value })}
                />
            );
        case 'between':
            return (
                <div className="flex items-center gap-2">
                    <Input
                        aria-label="Lower value"
                        className="w-24"
                        value={rule.betweenValue.value1}
                        onChange={(e) => edit({ betweenValue: { ...rule.betweenValue, value1: e.target.value } })}
                    />
                    <span className="text-sm">and</span>
                    <Input
                        aria-label="Upper value"
                        className="w-24"
                        value={rule.betweenValue.value2}
                        onChange={(e) => edit({ betweenValue: { ...rule.betweenValue, value2: e.target.value } })}
                    />
                </div>
            );
        case 'occurrenceDate':
            return (
                <Input
                    type="date"
                    aria-label="Date"
                    className="w-48"
                    value={rule.dateValue}
                    onChange={(e) => edit({ dateValue: e.target.value })}
                />
            );
        case 'duplicateValue':
            return (
                <Select value={rule.repeatValue} onValueChange={(repeatValue) => edit({ repeatValue })}>
                    <SelectTrigger size="sm" aria-label="Type of value">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="0">Duplicate value</SelectItem>
                        <SelectItem value="1">Unique value</SelectItem>
                    </SelectContent>
                </Select>
            );
        case 'top10':
        case 'top10_percent':
        case 'last10':
        case 'last10_percent': {
            const percent = type === 'top10_percent' || type === 'last10_percent';
            return (
                <div className="flex items-center gap-2 text-sm">
                    {type === 'top10' || type === 'top10_percent' ? 'Top' : 'Last'}
                    <Input
                        type="number"
                        aria-label={percent ? 'Percent of cells' : 'Number of cells'}
                        className="w-20"
                        value={rule.projectValue}
                        onChange={(e) => edit({ projectValue: e.target.value })}
                    />
                    {percent && '%'}
                </div>
            );
        }
        default:
            return null;
    }
}

// A tick box that turns one of the rule's colors on, and the swatch that picks it.
function ColorChoice({
    id,
    label,
    choice,
    onChange,
}: {
    id: string;
    label: string;
    choice: { check: boolean; color: string };
    onChange: (choice: { check: boolean; color: string }) => void;
}) {
    return (
        <div className="flex items-center gap-3">
            <Checkbox
                id={id}
                checked={choice.check}
                onCheckedChange={(checked) => onChange({ ...choice, check: checked === true })}
            />
            <Label htmlFor={id} className="text-sm w-20">
                {label}
            </Label>
            <Popover>
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Choose ${label.toLowerCase()}`}
                        className="h-6 w-10 p-0"
                        style={{ backgroundColor: choice.color }}
                    />
                </PopoverTrigger>
                <PopoverContent className="w-auto p-3">
                    <ColorPicker
                        value={choice.color}
                        showReset={false}
                        onChange={(color) => onChange({ ...choice, color })}
                    />
                </PopoverContent>
            </Popover>
        </div>
    );
}
