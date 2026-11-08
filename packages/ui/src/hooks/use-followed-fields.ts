// A form over a record that keeps changing under it, such as a contact card: a field the user changed stays, and every
// other field follows the record. It returns whether anything is typed, which is what the form's held etag answers to.

import { useEffect } from 'react';
import type { FieldPath, FieldPathValue, FieldValues, UseFormReturn } from 'react-hook-form';

export function useFollowedFields<Values extends FieldValues, Name extends FieldPath<Values>>(
    form: UseFormReturn<Values>,
    names: readonly Name[],
    record: { [Field in Name]?: FieldPathValue<Values, Field> } | undefined,
): boolean {
    // react-hook-form mutates dirtyFields in place, so the compiler's cache keyed on that object would never change.
    'use no memo';

    const dirtyNames = Object.keys(form.formState.dirtyFields).join();

    // Resetting an unchanged list would remount its rows.
    useEffect(() => {
        if (!record) return;
        for (const name of names) {
            const followed = JSON.stringify(form.getValues(name)) === JSON.stringify(record[name]);
            if (!followed && !form.getFieldState(name).isDirty) form.resetField(name, { defaultValue: record[name] });
        }
    }, [record, form, names, dirtyNames]);

    return dirtyNames !== '';
}
