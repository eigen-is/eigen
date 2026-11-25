// The typed value of a people-picking field, such as a guest list, a share dialog or a new chat. It parses the
// "Name <email>" text a picked suggestion arrives as, and names a typed address by the user's contact for it, so
// every field reads a known address the same way. The caller's `onAdd` decides whether the person is taken, and an
// address it can't read or a person refused keeps the text in the field, with the reason ContactAddRow shows under it.

import { useContacts } from '@workspace/lib/contacts';
import { contactFullName, findContactByEmail } from '@workspace/lib/types/contact';
import type { ParsedContactInput } from '@workspace/lib/validation';
import { parseContactInput } from '@workspace/lib/validation';
import { useCallback, useState } from 'react';

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
    // A reason holds until the text changes, so an edit or the caller's reset clears it, and retyping the same text
    // brings no old reason back before it is submitted again.
    const [refusal, setRefusal] = useState<string>();

    const trySubmit = (input: string): boolean => {
        if (!input.trim()) return false;
        const parsed = parseContactInput(input);
        if (!parsed) {
            setRefusal('Enter a valid email address');
            return false;
        }
        const known = contacts && findContactByEmail(contacts, parsed.email);
        const displayName = parsed.displayName ?? ((known && contactFullName(known)) || undefined);
        const reason = onAdd({ email: parsed.email, displayName });
        if (reason) {
            setRefusal(reason);
            return false;
        }
        setValue('');
        return true;
    };

    // Stable, since callers reset the field from an effect that lists it.
    const reset = useCallback((next: string) => {
        setRefusal(undefined);
        setValue(next);
    }, []);

    const handleChange = (input: string) => {
        setRefusal(undefined);
        if (input.includes('<') && input.includes('>') && trySubmit(input)) return;
        setValue(input);
    };

    return {
        value,
        setValue: reset,
        handleChange,
        submit: () => {
            trySubmit(value);
        },
        error: refusal,
    };
}
