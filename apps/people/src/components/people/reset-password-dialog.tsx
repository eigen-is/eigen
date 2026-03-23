import {useState} from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Field, FieldContent, FieldGroup, FieldLabel} from '@workspace/ui/components/field';
import {useResetUserPassword} from '@workspace/lib/people';

interface ResetPasswordDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    userId: string;
    userName: string;
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

export function ResetPasswordDialog({open, onOpenChange, userId, userName}: ResetPasswordDialogProps) {
    const [password, setPassword] = useState(() => generatePassword());
    const resetPassword = useResetUserPassword();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!password || password.length < 8) return;
        await resetPassword.mutateAsync({userId, newPassword: password});
        onOpenChange(false);
    };

    const handleOpenChange = (next: boolean) => {
        if (next) setPassword(generatePassword());
        onOpenChange(next);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Reset password for {userName}</DialogTitle>
                    <DialogDescription>
                        Share the new password with the user securely. They can change it after logging in.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="grid gap-4">
                    <FieldGroup>
                        <Field>
                            <FieldLabel htmlFor="new-password">New password</FieldLabel>
                            <FieldContent>
                                <Input id="new-password" value={password}
                                       onChange={e => setPassword(e.target.value)}
                                       minLength={8} required/>
                            </FieldContent>
                        </Field>
                    </FieldGroup>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                        <Button type="submit" disabled={resetPassword.isPending}>
                            {resetPassword.isPending ? 'Resetting...' : 'Reset password'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
