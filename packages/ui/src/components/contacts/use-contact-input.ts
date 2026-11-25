// The typed value of a people-picking field, such as a guest list, a share dialog or a new chat. It parses the
// "Name <email>" text a picked suggestion arrives as, and names a typed address by the user's contact for it, so
// every field reads a known address the same way. A person already in the list is refused the same way in every
// field, and the caller's `onAdd` decides the rest. An address it can't read or a person refused keeps the text in the
// field, with the reason ContactAddRow shows under it. Its form counts typed text as a change and commits it on Save.

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
    hasText: boolean;
    // Adds the typed person, or returns the reason it refuses them, which the field shows too.
    commitTyped: () => string | undefined;
};

export function useContactInput({
    listed,
    onAdd,
}: {
    // The addresses the field's list holds already.
    listed: readonly string[];
    // Returns the reason it refuses the person, or nothing to take them.
    onAdd: (contact: NonNullable<ParsedContactInput>) => string | undefined;
}): ContactInput {
    const { data: contacts } = useContacts();
    const [value, setValue] = useState('');
    // A reason holds until the text changes, so an edit or the caller's reset clears it, and retyping the same text
    // brings no old reason back before it is submitted again.
    const [refusal, setRefusal] = useState<string>();

    const refuse = (reason: string) => {
        setRefusal(reason);
        return reason;
    };

    // The reason the person in `input` is refused, or nothing once they are added.
    const add = (input: string): string | undefined => {
        const parsed = parseContactInput(input);
        if (!parsed) return refuse('Enter a valid email address');
        if (listed.some((email) => email.toLowerCase() === parsed.email)) {
            return refuse(`${parsed.email} is already in the list`);
        }
        const known = contacts && findContactByEmail(contacts, parsed.email);
        const displayName = parsed.displayName ?? ((known && contactFullName(known)) || undefined);
        const reason = onAdd({ email: parsed.email, displayName });
        if (reason) return refuse(reason);
        setValue('');
    };

    const commitTyped = () => (value.trim() ? add(value) : undefined);

    // Stable, since callers reset the field from an effect that lists it.
    const reset = useCallback((next: string) => {
        setRefusal(undefined);
        setValue(next);
    }, []);

    const handleChange = (input: string) => {
        setRefusal(undefined);
        if (input.includes('<') && input.includes('>') && !add(input)) return;
        setValue(input);
    };

    return {
        value,
        setValue: reset,
        handleChange,
        submit: () => {
            commitTyped();
        },
        error: refusal,
        hasText: !!value.trim(),
        commitTyped,
    };
}
