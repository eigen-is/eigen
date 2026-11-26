// The two fields every link dialog shares, such as the Sheets cell link's and the Docs text link's: the text the link
// shows and the address it opens. The address field says so under itself when webLinkHref refuses what was typed, or
// once the form was submitted without one, and each dialog keeps its own submit and what it stores.

import { webLinkHref } from '@workspace/lib/validation';
import { useId } from 'react';
import { Field, FieldError, FieldLabel } from './field';
import { useFormSubmitted } from './form-shell';
import { Input } from './input';

type LinkFieldProps = {
    value: string;
    onValueChange: (value: string) => void;
};

export function LinkTextField({
    value,
    onValueChange,
    autoFocus,
    disabled,
}: LinkFieldProps & { autoFocus?: boolean; disabled?: boolean }) {
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

export function LinkAddressField({ value, onValueChange }: LinkFieldProps) {
    const submitted = useFormSubmitted();
    const refusal =
        value.trim() === ''
            ? submitted && 'Add a link address'
            : webLinkHref(value) == null && 'Please enter a valid link';
    const refusalId = useId();
    return (
        <Field>
            <FieldLabel htmlFor="link-address">Link address</FieldLabel>
            <Input
                id="link-address"
                aria-invalid={refusal ? true : undefined}
                aria-describedby={refusal ? refusalId : undefined}
                spellCheck="false"
                value={value}
                onChange={(e) => onValueChange(e.target.value)}
            />
            {refusal && <FieldError id={refusalId}>{refusal}</FieldError>}
        </Field>
    );
}
