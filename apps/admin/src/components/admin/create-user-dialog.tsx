// The admin's dialog for a new user account: name, username on the server's mail domain, password and role.
// The users table opens it, and its hook creates the account on the server. Create with a field missing or wrong,
// such as a password that is too short, says so under that field and creates nothing.

import { useCreateUser } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import type { OrgRole } from '@workspace/lib/types/admin';
import { FIELD_MESSAGES, MIN_PASSWORD_LENGTH, validateUsername } from '@workspace/lib/validation';
import { Field, FieldContent, FieldError, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { useFormSubmitted } from '@workspace/ui/components/form-shell';
import { Input } from '@workspace/ui/components/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@workspace/ui/components/input-group';
import { LoadingState } from '@workspace/ui/components/layout/app';
import { RequiredTextField } from '@workspace/ui/components/required-text-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useId, useState } from 'react';

type CreateUserDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

export function CreateUserDialog({ open, onOpenChange }: CreateUserDialogProps) {
    const { data: config } = usePublicConfig();

    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title="Create user">
            {config ? (
                <CreateUserForm organizationId={config.orgId} mailDomain={config.mailDomain} />
            ) : (
                <LoadingState />
            )}
        </FormDialog>
    );
}

type NewUser = { name: string; username: string; password: string };

// Mounted with the dialog, so each opening starts empty, the password included.
function CreateUserForm({ organizationId, mailDomain }: { organizationId: string; mailDomain: string }) {
    const [user, setUser] = useState<NewUser>({ name: '', username: '', password: '' });
    const [role, setRole] = useState<Exclude<OrgRole, 'owner'>>('member');
    const createUser = useCreateUser(organizationId);

    return (
        <FormDialogForm
            changed={user.name !== '' || user.username !== '' || user.password !== '' || role !== 'member'}
            submitLabel="Create"
            onSubmit={async () => {
                const problems = problemsOf(user);
                if (!user.name.trim() || problems.username || problems.password) return false;
                await createUser.mutateAsync({
                    name: user.name.trim(),
                    email: `${localPart(user.username)}@${mailDomain}`,
                    password: user.password,
                    role,
                });
            }}
        >
            <CreateUserFields
                user={user}
                onChange={(patch) => setUser((prev) => ({ ...prev, ...patch }))}
                mailDomain={mailDomain}
            />

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
        </FormDialogForm>
    );
}

// Its own component, so it reads whether its form's Create was pressed.
function CreateUserFields({
    user,
    onChange,
    mailDomain,
}: {
    user: NewUser;
    onChange: (patch: Partial<NewUser>) => void;
    mailDomain: string;
}) {
    const id = useId();
    const problems = useFormSubmitted() ? problemsOf(user) : {};

    return (
        <>
            <RequiredTextField
                label="Name"
                value={user.name}
                onChange={(name) => onChange({ name })}
                message={FIELD_MESSAGES.nameMissing}
            />

            <Field>
                <FieldLabel htmlFor={`${id}-username`}>Username</FieldLabel>
                <FieldContent>
                    <InputGroup>
                        <InputGroupInput
                            id={`${id}-username`}
                            value={user.username}
                            onChange={(e) => onChange({ username: e.target.value })}
                            aria-invalid={!!problems.username || undefined}
                            aria-describedby={problems.username ? `${id}-username-error` : undefined}
                        />
                        <InputGroupAddon align="inline-end">
                            <InputGroupText>@{mailDomain}</InputGroupText>
                        </InputGroupAddon>
                    </InputGroup>
                    {problems.username && <FieldError id={`${id}-username-error`}>{problems.username}</FieldError>}
                </FieldContent>
            </Field>

            <Field>
                <FieldLabel htmlFor={`${id}-password`}>Password</FieldLabel>
                <FieldContent>
                    <Input
                        id={`${id}-password`}
                        type="password"
                        value={user.password}
                        onChange={(e) => onChange({ password: e.target.value })}
                        aria-invalid={!!problems.password || undefined}
                        aria-describedby={problems.password ? `${id}-password-error` : undefined}
                    />
                    {problems.password && <FieldError id={`${id}-password-error`}>{problems.password}</FieldError>}
                </FieldContent>
            </Field>
        </>
    );
}

// What an admin pastes after an @ is dropped, since the address is always on this server's mail domain.
const localPart = (username: string) => username.toLowerCase().split('@')[0];

function problemsOf(user: NewUser): { username?: string; password?: string } {
    return {
        username: user.username ? (validateUsername(localPart(user.username)) ?? undefined) : 'Add a username',
        password: user.password.length < MIN_PASSWORD_LENGTH ? FIELD_MESSAGES.passwordTooShort : undefined,
    };
}
