// The data-validation dialog, opened from the Data menu: it edits a rule for a range, such as a drop-down list, a tick
// box or a number condition. It opens on the focus cell's rule, and OK checks the draft and puts the rule on the
// range. A refused range or value keeps it open with the reason under the field. A grid button hands its place to the
// cell-range picker, which opens this dialog again with the draft and the picked range or list source.

import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Table } from 'lucide-react';
import type React from 'react';
import { useContext, useId, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog, useDialogProps } from '../../hooks/useDialog';
import type { Context, DataRegulationProps } from '../../state';
import {
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
import { getSheet } from '../../state/api/common';
import type { RangeOrWholeAxis } from '../../state/types';
import { CellRangeDialog } from '../CellRangeDialog';

const VERIFICATION_TYPES = [
    { value: 'dropdown', label: 'drop-down list' },
    { value: 'checkbox', label: 'Checkbox' },
    { value: 'number', label: 'Number' },
    { value: 'number_integer', label: 'Number-integer' },
    { value: 'number_decimal', label: 'Number-decimal' },
    { value: 'text_content', label: 'Text-content' },
    { value: 'text_length', label: 'Text-length' },
    { value: 'date', label: 'Date' },
];

const NUMBER_CONDITIONS = [
    { value: 'between', label: 'Between' },
    { value: 'notBetween', label: 'Not between' },
    { value: 'equal', label: 'Equal' },
    { value: 'notEqualTo', label: 'Not equal to' },
    { value: 'moreThanThe', label: 'More than the' },
    { value: 'lessThan', label: 'Less than' },
    { value: 'greaterOrEqualTo', label: 'Greater or equal to' },
    { value: 'lessThanOrEqualTo', label: 'Less than or equal to' },
];

const DATE_CONDITIONS = [
    { value: 'between', label: 'Between' },
    { value: 'notBetween', label: 'Not between' },
    { value: 'equal', label: 'Equal' },
    { value: 'notEqualTo', label: 'Not equal to' },
    { value: 'earlierThan', label: 'Earlier than' },
    { value: 'noEarlierThan', label: 'No earlier than' },
    { value: 'laterThan', label: 'Later than' },
    { value: 'noLaterThan', label: 'No later than' },
];

const TEXT_CONTENT_CONDITIONS = [
    { value: 'include', label: 'Include' },
    { value: 'exclude', label: 'Exclude' },
    { value: 'equal', label: 'Equal' },
];

const HINT_TOGGLES = [
    { value: 'prohibitInput', label: 'Prohibit input when input data is invalid' },
    { value: 'hintShow', label: 'Show prompt when the cell is selected' },
] as const;

// What OK and Delete verification say when the range names no cells.
const NO_RANGE_MESSAGE = 'The selection operation has not been performed yet';

// The draft's text fields, each typed into an input.
type TextField = 'rangeTxt' | 'value1' | 'value2' | 'hintValue';

// Why OK or Delete verification refused the draft: its range, or the values its condition compares against.
type Problem = { field: 'range' | 'value'; message: string };

// `draft` is the rule as the user left it when the range picker took this dialog's place.
export function DataVerification({ draft: reopenedDraft }: { draft?: DataRegulationProps }) {
    const { context, setContext } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();
    const { showFormDialog, showNonModalDialog, hideDialog } = useDialog();
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
            <p id={problemId} className="mt-1.5 text-sm text-destructive">
                {problem.message}
            </p>
        );

    // The picker leaves the grid usable to pick on, so rangeDialog.show keeps the cell editor out of the way. Every
    // way it closes, Escape included, opens this dialog again and clears the flag: left set, it would park the cell
    // editor off-screen for good. Its OK opens this dialog in its place, which drops the picker's onClose unrun.
    const pickRange = (field: 'rangeTxt' | 'value1') => {
        const reopen = (picked?: string) => {
            setContext((ctx) => {
                ctx.rangeDialog.show = false;
            });
            showFormDialog(<DataVerification draft={picked == null ? draft : { ...draft, [field]: picked }} />);
        };
        setContext((ctx) => {
            ctx.rangeDialog.show = true;
        });
        showNonModalDialog(
            <CellRangeDialog value={draft[field]} variant="validation" onConfirm={reopen} onCancel={hideDialog} />,
            { onClose: () => reopen() },
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

    const deleteVerification = () => {
        const target = rangeOrRefuse();
        if (!target) return;
        setContext((ctx) => {
            clearValidations(getSheet(ctx), target);
        });
        dialogProps.onOpenChange(false);
    };

    return (
        <FormDialog {...dialogProps} title="Data verification" size="md">
            <FormDialogForm
                submitLabel="OK"
                onSubmit={apply}
                footerStart={
                    <Button variant="outline" onClick={deleteVerification}>
                        Delete verification
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
                        <div className="text-sm font-medium">Verification condition</div>
                        <Select
                            value={draft.type}
                            onValueChange={(type) => {
                                // A tick box arrives usable: the same TRUE/FALSE pair Insert → Tick box writes, so the
                                // two routes to a checkbox rule agree.
                                const isCheckbox = type === 'checkbox';
                                update({
                                    type,
                                    type2: CONDITION_DEFAULTS[type] ?? '',
                                    value1: isCheckbox ? CHECKBOX_CHECKED_VALUE : '',
                                    value2: isCheckbox ? CHECKBOX_UNCHECKED_VALUE : '',
                                });
                            }}
                        >
                            <SelectTrigger size="sm" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {VERIFICATION_TYPES.map((v) => (
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
                                        placeholder="Please enter the options, separated by commas, such as 1,2,3,4,5"
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
                                        placeholder="Please enter content"
                                        {...textField('value1', 'Selected')}
                                    />
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-sm shrink-0">Not selected</span>
                                    <Input
                                        className="h-8"
                                        placeholder="Please enter content"
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
                                <Input
                                    className="h-8"
                                    placeholder="Please enter the specified text"
                                    {...textField('value1', 'Text')}
                                />
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
                                placeholder="Please enter the prompt displayed when the cell is selected"
                                {...textField('hintValue', 'Prompt')}
                            />
                        )}
                    </div>
                </div>
            </FormDialogForm>
        </FormDialog>
    );
}

// The condition a new rule of each type starts on. A list and a tick box have none.
const CONDITION_DEFAULTS: Record<string, string> = {
    number: 'between',
    number_integer: 'between',
    number_decimal: 'between',
    text_length: 'between',
    date: 'between',
    text_content: 'include',
};

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
            ? validationAt(getSheet(context).dataValidations, last.row_focus, last.column_focus)
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
