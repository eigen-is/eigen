import type { Ref } from 'react';

export type ContactAutosuggestProps = {
    initialValue?: string;
    value?: string;
    onChange?: (value: string) => void;
    appendMode?: boolean;
    onlyInternalMails?: boolean;
    excludeEmails?: string[];
    className?: string;
    suggestionsClassName?: string;
    inputClassName?: string;
    placeholder?: string;
    disabled?: boolean;
    autoComplete?: string;
    id?: string;
    name?: string;
    required?: boolean;
    inputRef?: Ref<HTMLInputElement>;
    onSubmit?: (value: string) => void;
    // Empty-input Enter runs the caller's primary action instead of a no-op submit.
    onEmptyEnter?: () => void;
    // Show team members as default suggestions before the 2-char minimum (the chat wizard's picker).
    listOnEmptyQuery?: boolean;
};
