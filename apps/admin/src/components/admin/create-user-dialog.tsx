import { useCreateUser } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import { validateUsername } from '@workspace/lib/validation';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Field, FieldContent, FieldGroup, FieldLabel } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@workspace/ui/components/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useEffect, useState } from 'react';

type CreateUserDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    organizationId?: string;
};

export function CreateUserDialog({ open, onOpenChange }: CreateUserDialogProps) {
    const [name, setName] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [role, setRole] = useState<'user' | 'admin'>('user');
    const [usernameError, setUsernameError] = useState('');
    const { data: config } = usePublicConfig();
    const createUser = useCreateUser(config?.orgId);

    // Reset the draft (incl. password) whenever the dialog closes. Keying off `open` covers every
    // close path — submit, Cancel, Escape, overlay — since a controlled Radix Dialog doesn't
    // re-fire its own onOpenChange when the parent flips `open` externally.
    useEffect(() => {
        if (!open) {
            setName('');
            setUsername('');
            setPassword('');
            setRole('user');
            setUsernameError('');
        }
    }, [open]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!config) return;
        const normalized = username.toLowerCase().split('@')[0];
        const validationError = validateUsername(normalized);
        if (validationError) {
            setUsernameError(validationError);
            return;
        }
        setUsernameError('');
        const email = `${normalized}@${config.mailDomain}`;
        if (!name || !username || !password) return;

        await createUser.mutateAsync({ name, email, password, role });
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Create User</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit}>
                    <FieldGroup>
                        <Field>
                            <FieldLabel htmlFor="name">Name</FieldLabel>
                            <FieldContent>
                                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
                            </FieldContent>
                        </Field>

                        <Field>
                            <FieldLabel htmlFor="username">Username</FieldLabel>
                            <FieldContent>
                                <InputGroup>
                                    <InputGroupInput
                                        id="username"
                                        value={username}
                                        onChange={(e) => setUsername(e.target.value)}
                                        required
                                    />
                                    <InputGroupAddon align="inline-end">
                                        <InputGroupText>@{config?.mailDomain}</InputGroupText>
                                    </InputGroupAddon>
                                </InputGroup>
                                {usernameError && <p className="text-sm text-destructive">{usernameError}</p>}
                            </FieldContent>
                        </Field>

                        <Field>
                            <FieldLabel htmlFor="password">Password</FieldLabel>
                            <FieldContent>
                                <Input
                                    id="password"
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    minLength={8}
                                    required
                                />
                            </FieldContent>
                        </Field>

                        <Field>
                            <FieldLabel htmlFor="role">Role</FieldLabel>
                            <FieldContent>
                                <Select value={role} onValueChange={(v) => setRole(v as 'user' | 'admin')}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="user">Member</SelectItem>
                                        <SelectItem value="admin">Admin</SelectItem>
                                    </SelectContent>
                                </Select>
                            </FieldContent>
                        </Field>
                    </FieldGroup>

                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={createUser.isPending}>
                            {createUser.isPending ? 'Creating...' : 'Create'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
