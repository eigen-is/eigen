// The typed value of a people-picking field, such as a guest list, a share dialog or a new chat. It parses the
// "Name <email>" text a picked suggestion arrives as, and names a typed address by the user's contact for it, so
// every field reads a known address the same way. The caller's `onAdd` decides whether the person is taken, and an
// address it can't read or a person refused keeps the text in the field, with the reason ContactAddRow shows under it.

import { useContacts } from '@workspace/lib/contacts';
import { contactFullName, findContactByEmail } from '@workspace/lib/types/contact';
import type { ParsedContactInput } from '@workspace/lib/validation';
import { parseContactInput } from '@workspace/lib/validation';
import { useState } from 'react';

type ContactInput = {
    value: string;
    setValue: (value: string) => void;
    handleChange: (input: string) => void;
    submit: () => void;
    error: string | undefined;
};

// `onAdd` returns the reason it refuses the person, or nothing to take them.
export function useContactInput(onAdd: (contact: NonNullable<ParsedContactInput>) => string | undefined): ContactInput {
    const { data: contacts } = useContacts();
    const [value, setValue] = useState('');
    // A reason holds only for the text it was given for, so an edit or the caller's reset clears it.
    const [refusal, setRefusal] = useState<{ input: string; reason: string }>();

    const trySubmit = (input: string): boolean => {
        if (!input.trim()) return false;
        const parsed = parseContactInput(input);
        if (!parsed) {
            setRefusal({ input, reason: 'Enter a valid email address' });
            return false;
        }
        const known = contacts && findContactByEmail(contacts, parsed.email);
        const displayName = parsed.displayName ?? ((known && contactFullName(known)) || undefined);
        const reason = onAdd({ email: parsed.email, displayName });
        if (reason) {
            setRefusal({ input, reason });
            return false;
        }
        setValue('');
        return true;
    };

    const handleChange = (input: string) => {
        if (input.includes('<') && input.includes('>') && trySubmit(input)) return;
        setValue(input);
    };

    return {
        value,
        setValue,
        handleChange,
        submit: () => {
            trySubmit(value);
        },
        error: refusal?.input === value ? refusal.reason : undefined,
    };
}
