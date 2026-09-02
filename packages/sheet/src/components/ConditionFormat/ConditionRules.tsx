import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { ColorPicker } from '@workspace/ui/components/media';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useCallback, useContext, useEffect, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { setConditionRules } from '../../state';

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

// The two _percent variants never had a description upstream; they render the
// heading alone.
const RULE_COPY: Record<ConditionRuleType, { label: string; description: string }> = {
    greaterThan: { label: 'Conditionformat-GreaterThan', description: 'Format cells greater than' },
    lessThan: { label: 'Conditionformat-LessThan', description: 'Format cells smaller than' },
    between: { label: 'Conditionformat-Betweenness', description: 'Format cells with values between' },
    equal: { label: 'Conditionformat-Equal', description: 'Format cells equal to' },
    textContains: {
        label: 'Conditionformat-TextContains',
        description: 'Format cells containing the following text',
    },
    occurrenceDate: {
        label: 'Conditionformat-OccurrenceDate',
        description: 'Format cells containing the following dates',
    },
    duplicateValue: {
        label: 'Conditionformat-DuplicateValue',
        description: 'Format cells containing the following types of values',
    },
    top10: { label: 'Conditionformat-Top10', description: 'Format the cells with the highest value' },
    top10_percent: { label: 'Conditionformat-Top10%', description: '' },
    last10: { label: 'Conditionformat-Last10', description: 'Format the cells with the smallest value' },
    last10_percent: { label: 'Conditionformat-Last10%', description: '' },
    aboveAverage: { label: 'Conditionformat-AboveAverage', description: 'Format cells above average' },
    belowAverage: { label: 'Conditionformat-SubAverage', description: 'Format cells below average' },
};

export function ConditionRules({ type }: { type: ConditionRuleType }) {
    const { context, setContext } = useContext(WorkbookContext);
    const { hideDialog } = useDialog();
    const { label, description } = RULE_COPY[type];
    const [colorRules, setColorRules] = useState<{
        textColor: string;
        cellColor: string;
    }>({ textColor: '#009966', cellColor: '#d0fae5' });

    const close = useCallback(
        (closeType: string) => {
            if (closeType === 'confirm') {
                setContext((ctx) => {
                    ctx.conditionRules.textColor.color = colorRules.textColor;
                    ctx.conditionRules.cellColor.color = colorRules.cellColor;
                    setConditionRules(ctx, ctx.conditionRules);
                });
            }
            setContext((ctx) => {
                ctx.conditionRules = {
                    rulesType: '',
                    rulesValue: '',
                    textColor: { check: false, color: '#009966' },
                    cellColor: { check: true, color: '#d0fae5' },
                    betweenValue: { value1: '', value2: '' },
                    dateValue: '',
                    repeatValue: '0',
                    projectValue: '10',
                };
            });
            hideDialog();
        },
        [colorRules, hideDialog, setContext],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only initialization from `type` prop and rangeDialog state
    useEffect(() => {
        setContext((ctx) => {
            ctx.conditionRules.rulesType = type;

            if (!ctx.rangeDialog) return;
            const rangeDialogType = ctx.rangeDialog.type;
            const rangeT = ctx.rangeDialog!.rangeTxt;
            if (rangeDialogType === 'conditionRulesbetween1') {
                ctx.conditionRules.betweenValue.value1 = rangeT;
            } else if (rangeDialogType === 'conditionRulesbetween2') {
                ctx.conditionRules.betweenValue.value2 = rangeT;
            } else if (rangeDialogType.includes('conditionRules')) {
                ctx.conditionRules.rulesValue = rangeT;
            } else if (rangeDialogType === '') {
                ctx.conditionRules = {
                    rulesType: type,
                    rulesValue: '',
                    textColor: { check: false, color: '#009966' },
                    cellColor: { check: true, color: '#d0fae5' },
                    betweenValue: { value1: '', value2: '' },
                    dateValue: '',
                    repeatValue: '0',
                    projectValue: '10',
                };
            }
            ctx.rangeDialog.type = '';
            ctx.rangeDialog.rangeTxt = '';
        });
    }, []);

    return (
        <div className="flex flex-col gap-4">
            <DialogHeader>
                <DialogTitle className="text-base">{label}</DialogTitle>
            </DialogHeader>

            <div>
                <p className="text-sm text-muted-foreground mb-2">{description}</p>

                {(type === 'greaterThan' || type === 'lessThan' || type === 'equal' || type === 'textContains') && (
                    <Input
                        className="mb-3 h-8"
                        type="text"
                        value={context.conditionRules.rulesValue}
                        onChange={(e) => {
                            const { value } = e.target;
                            setContext((ctx) => {
                                ctx.conditionRules.rulesValue = value;
                            });
                        }}
                    />
                )}

                {type === 'between' && (
                    <div className="flex items-center gap-2 mb-3">
                        <Input
                            className="h-8 w-24"
                            type="text"
                            value={context.conditionRules.betweenValue.value1}
                            onChange={(e) => {
                                const { value } = e.target;
                                setContext((ctx) => {
                                    ctx.conditionRules.betweenValue.value1 = value;
                                });
                            }}
                        />
                        <span className="text-sm">to</span>
                        <Input
                            className="h-8 w-24"
                            type="text"
                            value={context.conditionRules.betweenValue.value2}
                            onChange={(e) => {
                                const { value } = e.target;
                                setContext((ctx) => {
                                    ctx.conditionRules.betweenValue.value2 = value;
                                });
                            }}
                        />
                    </div>
                )}

                {type === 'occurrenceDate' && (
                    <Input
                        type="date"
                        className="mb-3 h-8 w-48"
                        value={context.conditionRules.dateValue}
                        onChange={(e) => {
                            const { value } = e.target;
                            setContext((ctx) => {
                                ctx.conditionRules.dateValue = value;
                            });
                        }}
                    />
                )}

                {type === 'duplicateValue' && (
                    <Select
                        value={context.conditionRules.repeatValue}
                        onValueChange={(value) => {
                            setContext((ctx) => {
                                ctx.conditionRules.repeatValue = value;
                            });
                        }}
                    >
                        <SelectTrigger size="sm" className="mb-3">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="0">Duplicate value</SelectItem>
                            <SelectItem value="1">Unique value</SelectItem>
                        </SelectContent>
                    </Select>
                )}

                {(type === 'top10' || type === 'top10_percent' || type === 'last10' || type === 'last10_percent') && (
                    <div className="flex items-center gap-2 mb-3 text-sm">
                        {type === 'top10' || type === 'top10_percent' ? 'Top' : 'Last'}
                        <Input
                            className="h-8 w-16"
                            type="number"
                            value={context.conditionRules.projectValue}
                            onChange={(e) => {
                                const { value } = e.target;
                                setContext((ctx) => {
                                    ctx.conditionRules.projectValue = value;
                                });
                            }}
                        />
                        {type === 'top10' || type === 'last10' ? '' : '%'}
                    </div>
                )}

                <p className="text-sm text-muted-foreground mt-3 mb-2">Set as:</p>

                <div className="rounded-md border p-3 space-y-3 mb-4">
                    <div className="flex items-center gap-3">
                        <Checkbox
                            id="checkTextColor"
                            checked={context.conditionRules.textColor.check}
                            onCheckedChange={(checked) => {
                                setContext((ctx) => {
                                    ctx.conditionRules.textColor.check = !!checked;
                                });
                            }}
                        />
                        <Label htmlFor="checkTextColor" className="text-sm w-20">
                            Text color
                        </Label>
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 w-10 p-0"
                                    style={{ backgroundColor: colorRules.textColor }}
                                />
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-3">
                                <ColorPicker
                                    value={colorRules.textColor}
                                    showReset={false}
                                    onChange={(color) => {
                                        if (color) {
                                            setColorRules((prev) => ({ ...prev, textColor: color }));
                                        }
                                    }}
                                />
                            </PopoverContent>
                        </Popover>
                    </div>
                    <div className="flex items-center gap-3">
                        <Checkbox
                            id="checkCellColor"
                            checked={context.conditionRules.cellColor.check}
                            onCheckedChange={(checked) => {
                                setContext((ctx) => {
                                    ctx.conditionRules.cellColor.check = !!checked;
                                });
                            }}
                        />
                        <Label htmlFor="checkCellColor" className="text-sm w-20">
                            Cell color
                        </Label>
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 w-10 p-0"
                                    style={{ backgroundColor: colorRules.cellColor }}
                                />
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-3">
                                <ColorPicker
                                    value={colorRules.cellColor}
                                    showReset={false}
                                    onChange={(color) => {
                                        if (color) {
                                            setColorRules((prev) => ({ ...prev, cellColor: color }));
                                        }
                                    }}
                                />
                            </PopoverContent>
                        </Popover>
                    </div>
                </div>
            </div>
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => close('close')}>
                    Cancel
                </Button>
                <Button size="sm" onClick={() => close('confirm')}>
                    OK
                </Button>
            </DialogFooter>
        </div>
    );
}
