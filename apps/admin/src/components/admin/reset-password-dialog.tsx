// The admin's dialog that gives a user a new password. A user's detail page opens it from its toolbar. It suggests a
// random password the admin may edit, and its hook sets it on the server, which signs the user out everywhere.

import { useResetUserPassword } from '@workspace/lib/admin';
import { MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import { Field, FieldContent, FieldGroup, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { useState } from 'react';

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
    const [password, setPassword] = useState(generatePassword);
    const resetPassword = useResetUserPassword();

    return (
        <FormDialogForm
            canSubmit={password.length >= MIN_PASSWORD_LENGTH}
            submitLabel="Reset password"
            onSubmit={async () => {
                await resetPassword.mutateAsync({ userId, password });
            }}
        >
            <FieldGroup>
                <Field>
                    <FieldLabel htmlFor="new-password">New password</FieldLabel>
                    <FieldContent>
                        <Input
                            id="new-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            minLength={MIN_PASSWORD_LENGTH}
                            required
                        />
                    </FieldContent>
                </Field>
            </FieldGroup>
        </FormDialogForm>
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
