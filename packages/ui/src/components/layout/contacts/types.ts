// TypeScript interfaces for the contact autosuggest component
import {Ref} from 'react';

export type ContactAutosuggestProps = {
    initialValue?: string;
    value?: string;
    onChange?: (value: string) => void;
    appendMode?: boolean;
    onlyEigenIsMails?: boolean;
    maxSuggestions?: number;
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
}

export type ContactSuggestion = {
    id: string;
    displayName: string;
    email: string;
    allEmails: string[];
}
