// The admin's dialog that gives a user a new password. A user's detail page opens it from its toolbar. It suggests a
// random password the admin may edit, and its hook sets it on the server, which signs the user out everywhere. A
// password that is too short is refused under the field.

import { useResetUserPassword } from '@workspace/lib/admin';
import { FIELD_MESSAGES, MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import { Field, FieldContent, FieldError, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { useFormSubmitted } from '@workspace/ui/components/form-shell';
import { Input } from '@workspace/ui/components/input';
import { useId, useState } from 'react';

type ResetPasswordDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    userId: string;
    userName: string;
};

export function ResetPasswordDialog({ open, onOpenChange, userId, userName }: ResetPasswordDialogProps) {
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title={`Reset password for ${userName}`}
            description="They are signed out everywhere. Share the new password with them securely."
        >
            <ResetPasswordForm userId={userId} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening suggests a new password.
function ResetPasswordForm({ userId }: { userId: string }) {
    const [suggested] = useState(generatePassword);
    const [password, setPassword] = useState(suggested);
    const resetPassword = useResetUserPassword();

    return (
        <FormDialogForm
            changed={password !== suggested}
            submitLabel="Reset password"
            onSubmit={async () => {
                if (password.length < MIN_PASSWORD_LENGTH) return false;
                await resetPassword.mutateAsync({ userId, password });
            }}
        >
            <NewPasswordField password={password} onPasswordChange={setPassword} />
        </FormDialogForm>
    );
}

// Its own component, so it reads whether its form's Reset password was pressed.
function NewPasswordField({
    password,
    onPasswordChange,
}: {
    password: string;
    onPasswordChange: (password: string) => void;
}) {
    const id = useId();
    const errorId = useId();
    const tooShort = useFormSubmitted() && password.length < MIN_PASSWORD_LENGTH;
    return (
        <Field>
            <FieldLabel htmlFor={id}>New password</FieldLabel>
            <FieldContent>
                <Input
                    id={id}
                    value={password}
                    onChange={(e) => onPasswordChange(e.target.value)}
                    aria-invalid={tooShort || undefined}
                    aria-describedby={tooShort ? errorId : undefined}
                />
                {tooShort && <FieldError id={errorId}>{FIELD_MESSAGES.passwordTooShort}</FieldError>}
            </FieldContent>
        </Field>
    );
}

function generatePassword() {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let password = '';
    const array = new Uint8Array(12);
    crypto.getRandomValues(array);
    for (const byte of array) {
        password += chars[byte % chars.length];
    }
    return password;
}
