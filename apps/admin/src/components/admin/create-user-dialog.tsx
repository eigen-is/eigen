// The admin's dialog for a new user account: name, username on the server's mail domain, password and role.
// The users table opens it, and its hook creates the account on the server. It suggests a random password the admin
// may edit or copy. Create with a field missing or wrong, such as a password that is too short, says so under that
// field and creates nothing.

import { useCreateUser } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import type { OrgRole } from '@workspace/lib/types/admin';
import { FIELD_MESSAGES, MIN_PASSWORD_LENGTH, validateUsername } from '@workspace/lib/validation';
import { Field, FieldContent, FieldError, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { useFormSubmitted } from '@workspace/ui/components/form-shell';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@workspace/ui/components/input-group';
import { LoadingState } from '@workspace/ui/components/layout/app';
import { RequiredTextField } from '@workspace/ui/components/required-text-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useId, useState } from 'react';
import { generatePassword, NewPasswordField } from './new-password-field';

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

// Mounted with the dialog, so each opening starts empty and suggests a new password.
function CreateUserForm({ organizationId, mailDomain }: { organizationId: string; mailDomain: string }) {
    const [suggested] = useState(generatePassword);
    const [user, setUser] = useState<NewUser>({ name: '', username: '', password: suggested });
    const [role, setRole] = useState<Exclude<OrgRole, 'owner'>>('member');
    const createUser = useCreateUser(organizationId);

    return (
        <FormDialogForm
            changed={user.name !== '' || user.username !== '' || user.password !== suggested || role !== 'member'}
            submitLabel="Create"
            onSubmit={async () => {
                if (!user.name.trim() || usernameProblem(user.username) || user.password.length < MIN_PASSWORD_LENGTH) {
                    return false;
                }
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
    const problem = useFormSubmitted() ? usernameProblem(user.username) : undefined;

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
                            autoComplete="off"
                            aria-invalid={!!problem || undefined}
                            aria-describedby={problem ? `${id}-username-error` : undefined}
                        />
                        <InputGroupAddon align="inline-end">
                            <InputGroupText>@{mailDomain}</InputGroupText>
                        </InputGroupAddon>
                    </InputGroup>
                    {problem && <FieldError id={`${id}-username-error`}>{problem}</FieldError>}
                </FieldContent>
            </Field>

            <NewPasswordField
                label="Password"
                password={user.password}
                onPasswordChange={(password) => onChange({ password })}
            />
        </>
    );
}

// What an admin pastes after an @ is dropped, since the address is always on this server's mail domain.
const localPart = (username: string) => username.toLowerCase().split('@')[0];

function usernameProblem(username: string) {
    return username ? (validateUsername(localPart(username)) ?? undefined) : 'Add a username';
}
