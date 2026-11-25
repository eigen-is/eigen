// The Split text dialog, opened from the Data menu: the separators to cut the selected column at, a preview of the
// pieces, and a question before the pieces overwrite cells to the right of the column. Apply with nothing to split at
// says why under the separators.

import { Checkbox } from '@workspace/ui/components/checkbox';
import {
    Field,
    FieldError,
    FieldGroup,
    FieldLabel,
    FieldLegend,
    FieldSet,
    FieldTitle,
} from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { useContext, useId, useState } from 'react';
import { WorkbookContext } from '../../context';
import { cellValue } from '../../engine/format';
import { useDialog, useDialogProps } from '../../hooks/useDialog';
import { getDataArr, getFlowdata, getRangetxt, getRegStr, updateMoreCell } from '../../state';

// Each id is the one getRegStr reads.
const SEPARATORS = [
    { id: 'Tab', label: 'Tab' },
    { id: 'semicolon', label: 'Semicolon' },
    { id: 'comma', label: 'Comma' },
    { id: 'space', label: 'Space' },
];

export function SplitColumn() {
    const { context, setContext } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();
    const id = useId();
    const { showConfirm } = useDialog();
    const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
    const [otherValue, setOtherValue] = useState('');
    // Why the last Apply was refused, until the next change.
    const [refusal, setRefusal] = useState<{ field: 'separators' | 'other'; message: string }>();
    const refusalId = `${id}-refusal`;

    const regStr = getRegStr(selected, otherValue);
    const pieces = getDataArr(regStr, context);

    const toggle = (id: string, checked: boolean) => {
        setRefusal(undefined);
        setSelected((prev) => {
            const next = new Set(prev);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    };

    // The question takes the slot over, so this dialog's own close after the submit does nothing.
    const split = () => {
        const selection = context.selections?.[0];
        const data = getFlowdata(context);
        // The dialog opens on a selected column of a loaded sheet.
        if (!selection || !data) return;
        if (selected.has('other') && !otherValue) {
            setRefusal({ field: 'other', message: 'Type the other separator' });
            return false;
        }
        // One piece per cell leaves nothing to split.
        if (pieces[0].length === 1) {
            setRefusal({
                field: 'separators',
                message: regStr ? 'No selected cell holds these separators' : 'Choose a separator',
            });
            return false;
        }
        const r = selection.row[0];
        const c = selection.column[0];
        const write = () =>
            setContext((ctx) => {
                updateMoreCell(r, c, pieces, ctx);
            });
        let overwrites = false;
        for (let i = 0; i < pieces.length; i += 1) {
            for (let j = 1; j < pieces[0].length; j += 1) {
                if (cellValue(data[r + i][c + j]) != null) overwrites = true;
            }
        }
        if (!overwrites) {
            write();
            return;
        }
        const target = { row: [r, r + pieces.length - 1], column: [c + 1, c + pieces[0].length - 1] };
        showConfirm({
            title: 'Replace data?',
            description: (
                <>
                    There's already data in <strong>{getRangetxt(context, context.currentSheetId, target)}</strong>. Do
                    you want to replace it?
                </>
            ),
            confirmText: 'Replace',
            destructive: true,
            onConfirm: write,
        });
    };

    return (
        <FormDialog {...dialogProps} title="Split text">
            <FormDialogForm submitLabel="Apply" changed={selected.size > 0 || otherValue !== ''} onSubmit={split}>
                <FieldSet>
                    <FieldLegend variant="label">Separators</FieldLegend>
                    <FieldGroup data-slot="checkbox-group">
                        {SEPARATORS.map(({ id: separator, label }) => (
                            <Field orientation="horizontal" key={separator}>
                                <Checkbox
                                    id={`${id}-${separator}`}
                                    {...invalidIf(refusal?.field === 'separators', refusalId)}
                                    checked={selected.has(separator)}
                                    onCheckedChange={(c) => toggle(separator, c === true)}
                                />
                                <FieldLabel htmlFor={`${id}-${separator}`}>{label}</FieldLabel>
                            </Field>
                        ))}
                        <Field orientation="horizontal" className="w-fit">
                            <Checkbox
                                id={`${id}-other`}
                                {...invalidIf(refusal?.field === 'separators', refusalId)}
                                checked={selected.has('other')}
                                onCheckedChange={(c) => toggle('other', c === true)}
                            />
                            <FieldLabel htmlFor={`${id}-other`}>Other</FieldLabel>
                            <Input
                                className="w-20"
                                aria-label="Other separator"
                                {...invalidIf(refusal?.field === 'other', refusalId)}
                                value={otherValue}
                                onChange={(e) => {
                                    setRefusal(undefined);
                                    setOtherValue(e.target.value);
                                }}
                            />
                        </Field>
                        <Field orientation="horizontal">
                            <Checkbox
                                id={`${id}-splitsimple`}
                                checked={selected.has('splitsimple')}
                                onCheckedChange={(c) => toggle('splitsimple', c === true)}
                            />
                            <FieldLabel htmlFor={`${id}-splitsimple`}>Treat consecutive separators as one</FieldLabel>
                        </Field>
                    </FieldGroup>
                    {refusal && <FieldError id={refusalId}>{refusal.message}</FieldError>}
                </FieldSet>
                <Field>
                    <FieldTitle>Preview</FieldTitle>
                    <div className="border p-1.5 h-[100px] overflow-y-auto select-none [&_table]:border-collapse [&_td]:border [&_td]:border-border">
                        <table>
                            <tbody>
                                {Array.from(pieces.entries(), ([rowIndex, row]) => (
                                    <tr key={rowIndex}>
                                        {row.length === 0 ? (
                                            <td />
                                        ) : (
                                            Array.from(row.entries(), ([column, cell]) => <td key={column}>{cell}</td>)
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Field>
            </FormDialogForm>
        </FormDialog>
    );
}

// The marks of a control the refusal under the separators is about.
const invalidIf = (invalid: boolean, refusalId: string) => ({
    'aria-invalid': invalid,
    'aria-describedby': invalid ? refusalId : undefined,
});
