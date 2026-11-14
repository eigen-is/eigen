// The admin's dialog for a new user account: name, username on the server's mail domain, password and role.
// The users table opens it, and its hook creates the account on the server.

import { useCreateUser } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import type { OrgRole } from '@workspace/lib/types/admin';
import { MIN_PASSWORD_LENGTH, validateUsername } from '@workspace/lib/validation';
import { Field, FieldContent, FieldGroup, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@workspace/ui/components/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useState } from 'react';

type CreateUserDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

export function CreateUserDialog({ open, onOpenChange }: CreateUserDialogProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title="Create user">
            <CreateUserForm />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts empty, the password included.
function CreateUserForm() {
    const [name, setName] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [role, setRole] = useState<Exclude<OrgRole, 'owner'>>('member');
    const [usernameError, setUsernameError] = useState('');
    const { data: config } = usePublicConfig();
    const createUser = useCreateUser(config?.orgId);

    return (
        <FormDialogForm
            canSubmit={!!config && name !== '' && username !== '' && password.length >= MIN_PASSWORD_LENGTH}
            submitLabel="Create"
            onSubmit={async () => {
                if (!config) return false;
                const normalized = username.toLowerCase().split('@')[0];
                const validationError = validateUsername(normalized);
                setUsernameError(validationError ?? '');
                if (validationError) return false;
                await createUser.mutateAsync({
                    name,
                    email: `${normalized}@${config.mailDomain}`,
                    password,
                    role,
                });
            }}
        >
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
                            minLength={MIN_PASSWORD_LENGTH}
                            required
                        />
                    </FieldContent>
                </Field>

                <Field>
                    <FieldLabel htmlFor="role">Role</FieldLabel>
                    <FieldContent>
                        <Select
                            value={role}
                            // The two items below are the whole of what this can hand back.
                            onValueChange={(value) => setRole(value === 'admin' ? 'admin' : 'member')}
                        >
                            <SelectTrigger id="role">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="member">Member</SelectItem>
                                <SelectItem value="admin">Admin</SelectItem>
                            </SelectContent>
                        </Select>
                    </FieldContent>
                </Field>
            </FieldGroup>
        </FormDialogForm>
    );
}
