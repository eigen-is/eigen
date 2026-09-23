import { useResetUserPassword } from '@workspace/lib/admin';
import { MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import { Button } from '@workspace/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { Field, FieldContent, FieldGroup, FieldLabel } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { useEffect, useState } from 'react';

type ResetPasswordDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    userId: string;
    userName: string;
};

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

export function ResetPasswordDialog({ open, onOpenChange, userId, userName }: ResetPasswordDialogProps) {
    const [password, setPassword] = useState(() => generatePassword());
    const resetPassword = useResetUserPassword();

    useEffect(() => {
        if (open) setPassword(generatePassword());
    }, [open]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (password.length < MIN_PASSWORD_LENGTH) return;
        await resetPassword.mutateAsync({ userId, password });
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Reset password for {userName}</DialogTitle>
                    <DialogDescription>
                        They are signed out everywhere. Share the new password with them securely.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="grid gap-4">
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
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={resetPassword.isPending}>
                            {resetPassword.isPending ? 'Resetting...' : 'Reset password'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
