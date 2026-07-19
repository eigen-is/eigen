import { type ParsedContactInput, parseContactInput } from '@workspace/lib/validation';
import { useState } from 'react';

// The controlled-input plumbing every people-picking dialog repeats (drive share, calendar
// attendees, chat wizard): track the typed value, recognise the "Name <email>" string a picked
// ContactAutosuggest suggestion arrives as through onChange, parse it, and hand the contact to the
// caller. `onAdd` returns whether the contact was accepted — false (e.g. a rejected duplicate)
// keeps the raw text in the field for the user to see and edit.
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
