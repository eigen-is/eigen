// The password field of the admin's dialogs that set a user's password, such as Create user and Reset password.
// The dialog fills it with generatePassword() and the admin may edit it. It shows the password in clear text with a
// button that copies it, since the admin passes it on, and a password that is too short is refused under it.

import { copyToClipboard } from '@workspace/lib/clipboard';
import { FIELD_MESSAGES, MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import { Field, FieldContent, FieldError, FieldLabel } from '@workspace/ui/components/field';
import { useFormSubmitted } from '@workspace/ui/components/form-shell';
import { Input } from '@workspace/ui/components/input';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { Copy } from 'lucide-react';
import { useId } from 'react';

type NewPasswordFieldProps = {
    label: string;
    password: string;
    onPasswordChange: (password: string) => void;
};

export function NewPasswordField({ label, password, onPasswordChange }: NewPasswordFieldProps) {
    const id = useId();
    const errorId = useId();
    const tooShort = useFormSubmitted() && password.length < MIN_PASSWORD_LENGTH;
    return (
        <Field>
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            <FieldContent>
                <div className="flex items-center gap-2">
                    {/* Clear text, so Chrome sees no sign-in form and fills in no saved login. */}
                    <Input
                        id={id}
                        value={password}
                        onChange={(e) => onPasswordChange(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono"
                        aria-invalid={tooShort || undefined}
                        aria-describedby={tooShort ? errorId : undefined}
                    />
                    <TooltipButton
                        icon={Copy}
                        tooltipText="Copy password"
                        className="shrink-0"
                        onClick={() => copyToClipboard(password, 'Password copied')}
                    />
                </div>
                {tooShort && <FieldError id={errorId}>{FIELD_MESSAGES.passwordTooShort}</FieldError>}
            </FieldContent>
        </Field>
    );
}

export function generatePassword() {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let password = '';
    const array = new Uint8Array(12);
    crypto.getRandomValues(array);
    for (const byte of array) {
        password += chars[byte % chars.length];
    }
    return password;
}
