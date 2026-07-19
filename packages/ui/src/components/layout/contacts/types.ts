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
    // Enter on an empty input runs the caller's primary action instead of a no-op submit (new-chat wizard's step-1 advance/open).
    onEmptyEnter?: () => void;
    // Surface internal team members as default suggestions before the 2-char minimum
    // (the new-chat wizard's member picker). Off for every other caller.
    listOnEmptyQuery?: boolean;
};
