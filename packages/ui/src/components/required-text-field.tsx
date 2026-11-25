// A labelled text field a form can't do without, such as a name or a title. Once its form's Save was pressed, a blank
// value shows the field's message under it and marks the field invalid, so the shell focuses it, unless the user may
// not change it; a reason from elsewhere, such as a name the server says is taken, shows the same way. An addon, such
// as a color swatch, sits inside the field before the text.

import type { ComponentProps, ReactNode } from 'react';
import { useId } from 'react';
import { Field, FieldError, FieldLabel } from './field';
import { useFormSubmitted } from './form-shell';
import { Input } from './input';
import { InputGroup, InputGroupAddon, InputGroupInput } from './input-group';

type RequiredTextFieldProps = {
    label: string;
    value: string;
    onChange: (value: string) => void;
    // What a blank value says, such as FIELD_MESSAGES.nameMissing.
    message: string;
    error?: string;
    addon?: ReactNode;
    className?: string;
    labelClassName?: string;
    inputClassName?: string;
} & Pick<ComponentProps<'input'>, 'ref' | 'id' | 'placeholder' | 'maxLength' | 'autoFocus' | 'disabled'>;

export function RequiredTextField({
    label,
    value,
    onChange,
    message,
    error,
    addon,
    className,
    labelClassName,
    inputClassName,
    id,
    ...inputProps
}: RequiredTextFieldProps) {
    const ownId = useId();
    const errorId = useId();
    const submitted = useFormSubmitted();
    const fieldId = id ?? ownId;
    const shown = error || (submitted && !inputProps.disabled && !value.trim() ? message : undefined);
    const props = {
        ...inputProps,
        id: fieldId,
        className: inputClassName,
        value,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
        'aria-invalid': !!shown || undefined,
        'aria-describedby': shown ? errorId : undefined,
    };
    return (
        <Field className={className}>
            <FieldLabel htmlFor={fieldId} className={labelClassName}>
                {label}
            </FieldLabel>
            {addon ? (
                <InputGroup>
                    <InputGroupAddon>{addon}</InputGroupAddon>
                    <InputGroupInput {...props} />
                </InputGroup>
            ) : (
                <Input {...props} />
            )}
            {shown && <FieldError id={errorId}>{shown}</FieldError>}
        </Field>
    );
}
