// The dialog for one conditional-format rule, such as "Greater than" or "Top 10", opened from the Format menu. It
// holds the rule's value and colors, and on OK it checks them with conditionRuleError: a refused value keeps the
// dialog open with the reason under the field, and a good one goes to addConditionRule. RULE_COPY names each rule
// once, so this dialog and the places that list rules, such as the Format menu, show the same words.

import { eigenColor } from '@workspace/lib/constants/colors';
import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { FieldError } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { ColorPicker } from '@workspace/ui/components/media';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useContext, useId, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialogProps } from '../../hooks/useDialog';
import type { ConditionRulesProps, ConditionRuleType } from '../../state';
import { addConditionRule, conditionRuleError } from '../../state';

// Each rule's name and description, shared by the Format menu, this dialog and Manage rules. A label such as "Equal to"
// keeps its last word, because Manage rules puts the rule's value after it.
export const RULE_COPY: Record<ConditionRuleType, { label: string; description: string }> = {
    greaterThan: { label: 'Greater than', description: 'Format cells greater than' },
    lessThan: { label: 'Less than', description: 'Format cells less than' },
    between: { label: 'Between', description: 'Format cells between' },
    equal: { label: 'Equal to', description: 'Format cells equal to' },
    textContains: { label: 'Text contains', description: 'Format cells that contain' },
    occurrenceDate: { label: 'Date is', description: 'Format cells on the date' },
    duplicateValue: { label: 'Duplicate value', description: 'Format cells with duplicate or unique values' },
    top10: { label: 'Top 10', description: 'Format cells with the highest values' },
    top10_percent: { label: 'Top 10%', description: 'Format cells with the highest values' },
    last10: { label: 'Last 10', description: 'Format cells with the lowest values' },
    last10_percent: { label: 'Last 10%', description: 'Format cells with the lowest values' },
    aboveAverage: { label: 'Above average', description: 'Format cells above the average' },
    belowAverage: { label: 'Below average', description: 'Format cells below the average' },
};

export function ConditionRules({ type }: { type: ConditionRuleType }) {
    const { context, setContext } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();
    const errorId = useId();
    const { label, description } = RULE_COPY[type];
    const [rule, setRule] = useState<ConditionRulesProps>({
        rulesType: type,
        rulesValue: '',
        textColor: { check: false, color: eigenColor('emerald', 600) },
        cellColor: { check: true, color: eigenColor('emerald', 100) },
        betweenValue: { value1: '', value2: '' },
        dateValue: '',
        repeatValue: '0',
        projectValue: '10',
    });
    // The reason the last OK was refused, until the next edit.
    const [error, setError] = useState<string>();
    const edit = (change: Partial<ConditionRulesProps>) => {
        setRule((prev) => ({ ...prev, ...change }));
        setError(undefined);
    };
    // Every value field points at the reason under it.
    const describedBy = { 'aria-invalid': error !== undefined, 'aria-describedby': error && errorId };
    const top = type === 'top10' || type === 'top10_percent';
    const percent = type === 'top10_percent' || type === 'last10_percent';

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
                    setContext((ctx) => addConditionRule(ctx, rule));
                }}
            >
                {type !== 'aboveAverage' && type !== 'belowAverage' && (
                    <div>
                        {(type === 'greaterThan' ||
                            type === 'lessThan' ||
                            type === 'equal' ||
                            type === 'textContains') && (
                            <Input
                                aria-label="Value"
                                {...describedBy}
                                value={rule.rulesValue}
                                onChange={(e) => edit({ rulesValue: e.target.value })}
                            />
                        )}
                        {type === 'between' && (
                            <div className="flex items-center gap-2">
                                <Input
                                    aria-label="Lower value"
                                    {...describedBy}
                                    className="w-24"
                                    value={rule.betweenValue.value1}
                                    onChange={(e) =>
                                        edit({ betweenValue: { ...rule.betweenValue, value1: e.target.value } })
                                    }
                                />
                                <span className="text-sm">and</span>
                                <Input
                                    aria-label="Upper value"
                                    {...describedBy}
                                    className="w-24"
                                    value={rule.betweenValue.value2}
                                    onChange={(e) =>
                                        edit({ betweenValue: { ...rule.betweenValue, value2: e.target.value } })
                                    }
                                />
                            </div>
                        )}
                        {type === 'occurrenceDate' && (
                            <Input
                                type="date"
                                aria-label="Date"
                                {...describedBy}
                                className="w-48"
                                value={rule.dateValue}
                                onChange={(e) => edit({ dateValue: e.target.value })}
                            />
                        )}
                        {type === 'duplicateValue' && (
                            <Select value={rule.repeatValue} onValueChange={(repeatValue) => edit({ repeatValue })}>
                                <SelectTrigger size="sm" aria-label="Type of value">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="0">Duplicate value</SelectItem>
                                    <SelectItem value="1">Unique value</SelectItem>
                                </SelectContent>
                            </Select>
                        )}
                        {(top || type === 'last10' || type === 'last10_percent') && (
                            <div className="flex items-center gap-2 text-sm">
                                {top ? 'Top' : 'Last'}
                                <Input
                                    type="number"
                                    aria-label={percent ? 'Percent of cells' : 'Number of cells'}
                                    {...describedBy}
                                    className="w-20"
                                    value={rule.projectValue}
                                    onChange={(e) => edit({ projectValue: e.target.value })}
                                />
                                {percent && '%'}
                            </div>
                        )}
                        {error && (
                            <FieldError id={errorId} className="mt-1.5">
                                {error}
                            </FieldError>
                        )}
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
