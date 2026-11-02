// The data-validation dialog, opened from the Data menu: it edits a rule for a range, such as a drop-down list, a tick
// box or a number condition. It opens on the focus cell's rule, and OK checks the draft and puts the rule on the
// range. A refused range or value keeps it open with the reason under the field. A grid button hands its place to the
// cell-range picker, which opens this dialog again with the draft and the picked range or list source.

import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { FieldError } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Table } from 'lucide-react';
import type React from 'react';
import { useContext, useId, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog, useDialogProps } from '../../hooks/useDialog';
import type { Context, DataRegulationProps, RangeOrWholeAxis } from '../../state';
import {
    api,
    applyDataVerification,
    CHECKBOX_CHECKED_VALUE,
    CHECKBOX_UNCHECKED_VALUE,
    clearValidations,
    getDropdownList,
    getRangetxt,
    validationAt,
    validationRange,
    validationValueProblem,
} from '../../state';
import { CellRangeDialog } from '../CellRangeDialog';

// Each rule type with the condition a new rule of it starts on. A list and a tick box have none.
const VALIDATION_TYPES = [
    { value: 'dropdown', label: 'Drop-down list', condition: '' },
    { value: 'checkbox', label: 'Checkbox', condition: '' },
    { value: 'number', label: 'Number', condition: 'between' },
    { value: 'number_integer', label: 'Whole number', condition: 'between' },
    { value: 'number_decimal', label: 'Decimal number', condition: 'between' },
    { value: 'text_content', label: 'Text', condition: 'include' },
    { value: 'text_length', label: 'Text length', condition: 'between' },
    { value: 'date', label: 'Date', condition: 'between' },
] as const;

const NUMBER_CONDITIONS = [
    { value: 'between', label: 'Between' },
    { value: 'notBetween', label: 'Not between' },
    { value: 'equal', label: 'Equal to' },
    { value: 'notEqualTo', label: 'Not equal to' },
    { value: 'moreThanThe', label: 'Greater than' },
    { value: 'lessThan', label: 'Less than' },
    { value: 'greaterOrEqualTo', label: 'Greater than or equal to' },
    { value: 'lessThanOrEqualTo', label: 'Less than or equal to' },
];

const DATE_CONDITIONS = [
    { value: 'between', label: 'Between' },
    { value: 'notBetween', label: 'Not between' },
    { value: 'equal', label: 'Equal to' },
    { value: 'notEqualTo', label: 'Not equal to' },
    { value: 'earlierThan', label: 'Earlier than' },
    { value: 'noEarlierThan', label: 'Not earlier than' },
    { value: 'laterThan', label: 'Later than' },
    { value: 'noLaterThan', label: 'Not later than' },
];

const TEXT_CONTENT_CONDITIONS = [
    { value: 'include', label: 'Includes' },
    { value: 'exclude', label: 'Does not include' },
    { value: 'equal', label: 'Equal to' },
];

const HINT_TOGGLES = [
    { value: 'prohibitInput', label: 'Prohibit input when input data is invalid' },
    { value: 'hintShow', label: 'Show prompt when the cell is selected' },
] as const;

// What OK and Delete validation say when the range names no cells.
const NO_RANGE_MESSAGE = 'Enter a cell range, such as A1:B10';

// The draft's text fields, each typed into an input.
type TextField = 'rangeTxt' | 'value1' | 'value2' | 'hintValue';

// Why OK or Delete validation refused the draft: its range, or the values its condition compares against.
type Problem = { field: 'range' | 'value'; message: string };

// `draft` is the rule as the user left it when the range picker took this dialog's place.
export function DataValidation({ draft: reopenedDraft }: { draft?: DataRegulationProps }) {
    const { context, setContext } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();
    const { showDialog, showNonModalDialog, hideDialog } = useDialog();
    const [draft, setDraft] = useState(() => reopenedDraft ?? draftAtSelection(context));
    const [problem, setProblem] = useState<Problem>();
    const problemId = useId();

    // A change to the draft takes back the message about it.
    const update = (change: Partial<DataRegulationProps>) => {
        setDraft((prev) => ({ ...prev, ...change }));
        setProblem(undefined);
    };

    const textField = (field: TextField, label: string) => ({
        'aria-label': label,
        'aria-describedby': problem?.field === (field === 'rangeTxt' ? 'range' : 'value') ? problemId : undefined,
        value: draft[field],
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => update({ [field]: e.target.value }),
    });

    const problemMessage = (field: Problem['field']) =>
        problem?.field === field && (
            <FieldError id={problemId} className="mt-1.5">
                {problem.message}
            </FieldError>
        );

    // The picker leaves the grid usable to pick on, so rangePickerOpen keeps the cell editor out of the way. However
    // the picker leaves the slot, the flag clears: left set, it would park the cell editor off-screen for good. Its OK
    // opens this dialog again with the pick, and Cancel or Escape with the draft as it was.
    const pickRange = (field: 'rangeTxt' | 'value1') => {
        const reopen = (picked?: string) =>
            showDialog(<DataValidation draft={picked == null ? draft : { ...draft, [field]: picked }} />);
        setContext((ctx) => {
            ctx.rangePickerOpen = true;
        });
        showNonModalDialog(
            <CellRangeDialog value={draft[field]} variant="validation" onConfirm={reopen} onCancel={hideDialog} />,
            {
                onClose: (reason) => {
                    setContext((ctx) => {
                        ctx.rangePickerOpen = false;
                    });
                    if (reason === 'closed') reopen();
                },
            },
        );
    };

    const rangeOrRefuse = () => {
        const target = validationRange(context, draft.rangeTxt);
        if (!target) setProblem({ field: 'range', message: NO_RANGE_MESSAGE });
        return target;
    };

    const apply = () => {
        const target = rangeOrRefuse();
        if (!target) return false;
        const message = validationValueProblem(draft);
        if (message) {
            setProblem({ field: 'value', message });
            return false;
        }
        setContext((ctx) => {
            const value1 = draft.type === 'dropdown' ? getDropdownList(ctx, draft.value1).join(',') : draft.value1;
            applyDataVerification(ctx, target, { ...draft, value1 });
        });
    };

    const deleteValidation = () => {
        const target = rangeOrRefuse();
        if (!target) return;
        setContext((ctx) => {
            clearValidations(api.getSheet(ctx), target);
        });
        dialogProps.onOpenChange(false);
    };

    return (
        <FormDialog {...dialogProps} title="Data validation" size="md">
            <FormDialogForm
                submitLabel="OK"
                onSubmit={apply}
                footerStart={
                    <Button variant="outline" onClick={deleteValidation}>
                        Delete validation
                    </Button>
                }
            >
                <div className="text-sm space-y-4 select-none">
                    <div>
                        <div className="text-sm font-medium mb-2">Cell range</div>
                        <div className="flex h-8 rounded-md border border-input overflow-hidden">
                            <Input
                                className="flex-1 border-none rounded-none h-full"
                                spellCheck={false}
                                {...textField('rangeTxt', 'Cell range')}
                            />
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                className="rounded-none"
                                aria-label="Select cell range"
                                onClick={() => pickRange('rangeTxt')}
                            >
                                <Table />
                            </Button>
                        </div>
                        {problemMessage('range')}
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium">Validation condition</div>
                        <Select
                            value={draft.type}
                            onValueChange={(value) => {
                                const picked = VALIDATION_TYPES.find((type) => type.value === value);
                                if (!picked) return;
                                // A tick box arrives usable: the same TRUE/FALSE pair Insert → Tick box writes, so the
                                // two routes to a checkbox rule agree.
                                const isCheckbox = picked.value === 'checkbox';
                                update({
                                    type: picked.value,
                                    type2: picked.condition,
                                    value1: isCheckbox ? CHECKBOX_CHECKED_VALUE : '',
                                    value2: isCheckbox ? CHECKBOX_UNCHECKED_VALUE : '',
                                });
                            }}
                        >
                            <SelectTrigger size="sm" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {VALIDATION_TYPES.map((v) => (
                                    <SelectItem value={v.value} key={v.value}>
                                        {v.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>

                        {draft.type === 'dropdown' && (
                            <div className="space-y-2">
                                <div className="flex h-8 rounded-md border border-input overflow-hidden">
                                    <Input
                                        className="flex-1 border-none rounded-none h-full"
                                        spellCheck={false}
                                        placeholder="Enter the options, separated by commas, such as 1,2,3,4,5"
                                        {...textField('value1', 'Options')}
                                    />
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        className="rounded-none"
                                        aria-label="Select options from a range"
                                        onClick={() => pickRange('value1')}
                                    >
                                        <Table />
                                    </Button>
                                </div>
                                <Label className="flex items-center gap-1.5">
                                    <Checkbox
                                        checked={draft.type2 === 'true'}
                                        onCheckedChange={(checked) => update({ type2: `${checked}` })}
                                    />
                                    Allow multiple selection
                                </Label>
                            </div>
                        )}

                        {draft.type === 'checkbox' && (
                            <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm shrink-0">Selected</span>
                                    <Input
                                        className="h-8"
                                        placeholder="Enter a value"
                                        {...textField('value1', 'Selected')}
                                    />
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-sm shrink-0">Not selected</span>
                                    <Input
                                        className="h-8"
                                        placeholder="Enter a value"
                                        {...textField('value2', 'Not selected')}
                                    />
                                </div>
                            </div>
                        )}

                        {(draft.type === 'number' ||
                            draft.type === 'number_integer' ||
                            draft.type === 'number_decimal' ||
                            draft.type === 'text_length') && (
                            <div className="space-y-2">
                                <ConditionSelect
                                    value={draft.type2}
                                    conditions={NUMBER_CONDITIONS}
                                    onChange={(type2) => update({ type2, value1: '', value2: '' })}
                                />
                                {draft.type2 === 'between' || draft.type2 === 'notBetween' ? (
                                    <div className="flex items-center gap-2">
                                        <Input
                                            type="number"
                                            className="h-8"
                                            placeholder="1"
                                            {...textField('value1', 'Value 1')}
                                        />
                                        <span className="text-sm">-</span>
                                        <Input
                                            type="number"
                                            className="h-8"
                                            placeholder="100"
                                            {...textField('value2', 'Value 2')}
                                        />
                                    </div>
                                ) : (
                                    <Input
                                        type="number"
                                        className="h-8"
                                        placeholder="Numeric value, such as 10"
                                        {...textField('value1', 'Value')}
                                    />
                                )}
                            </div>
                        )}

                        {draft.type === 'text_content' && (
                            <div className="space-y-2">
                                <ConditionSelect
                                    value={draft.type2}
                                    conditions={TEXT_CONTENT_CONDITIONS}
                                    onChange={(type2) => update({ type2, value1: '', value2: '' })}
                                />
                                <Input className="h-8" placeholder="Enter the text" {...textField('value1', 'Text')} />
                            </div>
                        )}

                        {draft.type === 'date' && (
                            <div className="space-y-2">
                                <ConditionSelect
                                    value={draft.type2}
                                    conditions={DATE_CONDITIONS}
                                    onChange={(type2) => update({ type2, value1: '', value2: '' })}
                                />
                                {draft.type2 === 'between' || draft.type2 === 'notBetween' ? (
                                    <div className="flex items-center gap-2">
                                        <Input type="date" className="h-8" {...textField('value1', 'Date 1')} />
                                        <span className="text-sm">-</span>
                                        <Input type="date" className="h-8" {...textField('value2', 'Date 2')} />
                                    </div>
                                ) : (
                                    <Input type="date" className="h-8" {...textField('value1', 'Date')} />
                                )}
                            </div>
                        )}
                        {problemMessage('value')}
                    </div>

                    <div className="space-y-2">
                        {HINT_TOGGLES.map(({ value, label }) => (
                            <Label className="flex items-center gap-1.5" key={value}>
                                <Checkbox
                                    checked={draft[value]}
                                    onCheckedChange={() => update({ [value]: !draft[value] })}
                                />
                                {label}
                            </Label>
                        ))}
                        {draft.hintShow && (
                            <Input
                                className="h-8"
                                placeholder="Enter the prompt shown when the cell is selected"
                                {...textField('hintValue', 'Prompt')}
                            />
                        )}
                    </div>
                </div>
            </FormDialogForm>
        </FormDialog>
    );
}

function ConditionSelect({
    value,
    conditions,
    onChange,
}: {
    value: string;
    conditions: readonly { value: string; label: string }[];
    onChange: (value: string) => void;
}) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger size="sm" className="w-full">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {conditions.map((v) => (
                    <SelectItem value={v.value} key={v.value}>
                        {v.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

// The draft the dialog opens on: the focus cell's rule, or a new list, over the selection. A column or row header's
// selection is named B:B or 2:2, so the rule covers the whole column or row.
function draftAtSelection(context: Context): DataRegulationProps {
    const last = context.selections?.at(-1);
    const named: RangeOrWholeAxis | undefined =
        last?.column_select && !last.row_select
            ? { row: [null, null], column: last.column }
            : last?.row_select && !last.column_select
              ? { row: last.row, column: [null, null] }
              : last;
    const rangeTxt = named ? getRangetxt(context, context.currentSheetId, named, context.currentSheetId) : '';
    const item =
        last?.row_focus != null && last.column_focus != null
            ? validationAt(api.getSheet(context).dataValidations, last.row_focus, last.column_focus)
            : undefined;
    return {
        type: item?.type ?? 'dropdown',
        type2: item?.type2 ?? '',
        rangeTxt,
        value1: item?.value1 ?? '',
        value2: item?.value2 ?? '',
        validity: item?.validity ?? '',
        remote: item?.remote ?? false,
        prohibitInput: item?.prohibitInput ?? false,
        hintShow: item?.hintShow ?? false,
        hintValue: item?.hintValue ?? '',
    };
}
