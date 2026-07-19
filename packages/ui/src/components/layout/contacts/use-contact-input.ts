import { type ParsedContactInput, parseContactInput } from '@workspace/lib/validation';
import { useState } from 'react';

// Shared input plumbing for people-picking dialogs: tracks the typed value, parses the
// "Name <email>" string a picked suggestion arrives as, and hands the contact to `onAdd`,
// which returns whether it was accepted — false keeps the raw text in the field for editing.
export function useContactInput(onAdd: (contact: NonNullable<ParsedContactInput>) => boolean) {
    const [value, setValue] = useState('');

    const trySubmit = (input: string): boolean => {
        const parsed = parseContactInput(input);
        if (!parsed || !onAdd(parsed)) return false;
        setValue('');
        return true;
    };

    const handleChange = (input: string) => {
        if (input.includes('<') && input.includes('>') && trySubmit(input)) return;
        setValue(input);
    };

    return { value, setValue, handleChange, submit: () => trySubmit(value) };
}
