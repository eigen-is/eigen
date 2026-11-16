// The typed value of a people-picking field, such as a guest list, a share dialog or a new chat. It parses the
// "Name <email>" text a picked suggestion arrives as, and names a typed address by the user's contact for it, so
// every field reads a known address the same way. The caller's `onAdd` decides whether the person is taken.

import { useContacts } from '@workspace/lib/contacts';
import { contactFullName, findContactByEmail } from '@workspace/lib/types/contact';
import type { ParsedContactInput } from '@workspace/lib/validation';
import { parseContactInput } from '@workspace/lib/validation';
import { useState } from 'react';

// `onAdd` returns false to refuse the person, which keeps the raw text in the field for editing.
export function useContactInput(onAdd: (contact: NonNullable<ParsedContactInput>) => boolean) {
    const { data: contacts } = useContacts();
    const [value, setValue] = useState('');

    const trySubmit = (input: string): boolean => {
        const parsed = parseContactInput(input);
        if (!parsed) return false;
        const known = contacts && findContactByEmail(contacts, parsed.email);
        const displayName = parsed.displayName ?? ((known && contactFullName(known)) || undefined);
        if (!onAdd({ email: parsed.email, displayName })) return false;
        setValue('');
        return true;
    };

    const handleChange = (input: string) => {
        if (input.includes('<') && input.includes('>') && trySubmit(input)) return;
        setValue(input);
    };

    return { value, setValue, handleChange, submit: () => trySubmit(value) };
}
