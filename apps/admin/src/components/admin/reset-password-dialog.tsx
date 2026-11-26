// The admin's dialog that gives a user a new password. A user's detail page opens it from its toolbar. It suggests a
// random password the admin may edit or copy, and its hook sets it on the server, which signs the user out everywhere.

import { useResetUserPassword } from '@workspace/lib/admin';
import { MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { useState } from 'react';
import { generatePassword, NewPasswordField } from './new-password-field';

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
            <NewPasswordField label="New password" password={password} onPasswordChange={setPassword} />
        </FormDialogForm>
    );
}
