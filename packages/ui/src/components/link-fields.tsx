// The two fields every link dialog shares, such as the Sheets cell link's and the Docs text link's: the text the link
// shows and the address it opens. The address field says so under itself when webLinkHref refuses what was typed, or
// when it is empty once the form's button was pressed, and each dialog keeps its own button and what it stores.

import { webLinkHref } from '@workspace/lib/validation';
import { useId } from 'react';
import { Field, FieldError, FieldLabel } from './field';
import { useFormSubmitted } from './form-shell';
import { Input } from './input';

type LinkFieldProps = {
    value: string;
    onValueChange: (value: string) => void;
    autoFocus?: boolean;
};

export function LinkTextField({ value, onValueChange, autoFocus, disabled }: LinkFieldProps & { disabled?: boolean }) {
    return (
        <Field>
            <FieldLabel htmlFor="link-text">Display text</FieldLabel>
            <Input
                id="link-text"
                spellCheck="false"
                autoFocus={autoFocus}
                disabled={disabled}
                value={value}
                onChange={(e) => onValueChange(e.target.value)}
            />
        </Field>
    );
}

export function LinkAddressField({ value, onValueChange, autoFocus }: LinkFieldProps) {
    const missing = useFormSubmitted() && value.trim() === '';
    const refused = value.trim() !== '' && webLinkHref(value) == null;
    const refusalId = useId();
    return (
        <Field>
            <FieldLabel htmlFor="link-address">Link address</FieldLabel>
            <Input
                id="link-address"
                autoFocus={autoFocus}
                aria-invalid={refused || missing}
                aria-describedby={refused || missing ? refusalId : undefined}
                spellCheck="false"
                value={value}
                onChange={(e) => onValueChange(e.target.value)}
            />
            {refused && <FieldError id={refusalId}>Please enter a valid link</FieldError>}
            {missing && <FieldError id={refusalId}>Enter a link address</FieldError>}
        </Field>
    );
}
