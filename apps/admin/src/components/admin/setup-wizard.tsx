// The first-run wizard that names the organization, picks where files are stored, and creates the admin account.
// The admin app shows it in place of everything else while the server reports that setup is still required, and
// the setup link's token proves the visitor ran the setup command. Complete setup with a field missing or wrong says
// so under that field and sends nothing.

import { useCheckSetupS3, useCompleteSetup, useHardenSetupS3 } from '@workspace/lib/admin';
import { getAdminAppUrl } from '@workspace/lib/api';
import { defaultSenderAddress } from '@workspace/lib/constants/mail';
import type { S3Config } from '@workspace/lib/types/mount';
import { EMPTY_S3 } from '@workspace/lib/types/mount';
import type { ServerStorageType, SetupStatus } from '@workspace/lib/types/settings';
import { FIELD_MESSAGES, MIN_PASSWORD_LENGTH, validateEmailAddress, validateUsername } from '@workspace/lib/validation';
import { EigenLoader } from '@workspace/ui/components/braket';
import { Button } from '@workspace/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { FieldError } from '@workspace/ui/components/field';
import { FormShell, useFormSubmitted } from '@workspace/ui/components/form-shell';
import { Input } from '@workspace/ui/components/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@workspace/ui/components/input-group';
import { Label } from '@workspace/ui/components/label';
import { EmptyState } from '@workspace/ui/components/layout/app';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import { CheckCircle2, KeyRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { StorageTypePicker } from './storage-type-picker';

const ORG_NAME_PLACEHOLDER = 'My organization';

export function SetupWizard({ status, setupToken }: { status: SetupStatus; setupToken: string | undefined }) {
    if (!setupToken) {
        return (
            <div className="h-screen bg-background">
                <EmptyState
                    icon={<KeyRound className="h-10 w-10" />}
                    message="Open the setup link that ./eigen setup printed."
                    hint="Lost it? Run ./eigen setup again on your server for a fresh one."
                />
            </div>
        );
    }
    return <SetupForm status={status} setupToken={setupToken} />;
}

type SetupFields = {
    orgName: string;
    // Empty means the org name; the server stores only a sender that differs from the defaults.
    senderName: string;
    senderAddress: string;
    adminName: string;
    adminUsername: string;
    adminPassword: string;
};

function SetupForm({ status, setupToken }: { status: SetupStatus; setupToken: string }) {
    const completeSetup = useCompleteSetup(setupToken);
    const s3Check = useCheckSetupS3(setupToken);
    const s3Harden = useHardenSetupS3(setupToken);
    const { pending, run } = useDialogPending();

    const [completed, setCompleted] = useState(false);
    const [fields, setFields] = useState<SetupFields>({
        orgName: '',
        senderName: '',
        senderAddress: defaultSenderAddress(status.mailDomain),
        adminName: '',
        adminUsername: '',
        adminPassword: '',
    });
    const [storageType, setStorageType] = useState<ServerStorageType>('local-fullnames');
    const [s3Config, setS3Config] = useState<S3Config>(EMPTY_S3);
    const [s3Verified, setS3Verified] = useState(true);
    const onS3Verified = useCallback((verified: boolean) => setS3Verified(verified), []);

    const handleSubmit = async () => {
        const problems = problemsOf(fields);
        if (Object.values(problems).some(Boolean) || !s3Verified) return false;
        await completeSetup.mutateAsync({
            orgName: fields.orgName.trim(),
            senderName: fields.senderName,
            senderAddress: fields.senderAddress,
            storageType,
            adminUsername: usernameOf(fields),
            adminPassword: fields.adminPassword,
            adminName: fields.adminName,
            ...(storageType === 's3'
                ? {
                      s3Endpoint: s3Config.endpoint,
                      s3Bucket: s3Config.bucket,
                      s3Prefix: s3Config.prefix,
                      s3Region: s3Config.region ?? '',
                      s3AccessKeyId: s3Config.accessKeyId,
                      s3SecretAccessKey: s3Config.secretAccessKey,
                  }
                : {}),
        });
        setCompleted(true);
    };

    if (completed) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background p-4">
                <Card className="w-full max-w-md">
                    <CardHeader className="text-center">
                        <CheckCircle2 className="mx-auto h-16 w-16 text-success mb-4" />
                        <CardTitle className="text-2xl">Setup complete!</CardTitle>
                        <CardDescription>
                            Eigen has been configured successfully. You can now log in with your admin account.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Button className="w-full" onClick={() => (window.location.href = getAdminAppUrl('login'))}>
                            Go to login
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
            <Card className="w-full max-w-lg">
                <CardHeader className="text-center">
                    <div className="mx-auto mb-4">
                        <EigenLoader className="h-12 w-auto" />
                    </div>
                    <CardTitle className="text-2xl">Welcome to Eigen</CardTitle>
                    <CardDescription>Let's configure your instance</CardDescription>
                </CardHeader>
                <CardContent>
                    <FormShell className="space-y-6" onSubmit={() => run(handleSubmit)} autoFocus>
                        <SetupFieldset
                            fields={fields}
                            onChange={(patch) => setFields((prev) => ({ ...prev, ...patch }))}
                            mailDomain={status.mailDomain}
                            storagePicker={
                                <StorageTypePicker
                                    storageType={storageType}
                                    onStorageTypeChange={setStorageType}
                                    s3Config={s3Config}
                                    onS3ConfigChange={setS3Config}
                                    checkS3={(config) => s3Check.mutateAsync(config)}
                                    hardenS3={(config, noncurrentDays) =>
                                        s3Harden.mutateAsync({ ...config, noncurrentDays })
                                    }
                                    onS3Verified={onS3Verified}
                                />
                            }
                        />

                        <div className="space-y-1.5">
                            <Button type="submit" pending={pending} className="w-full">
                                Complete setup
                            </Button>
                            {!s3Verified && (
                                <p className="text-xs text-muted-foreground text-center">
                                    Test the S3 connection first.
                                </p>
                            )}
                        </div>
                    </FormShell>
                </CardContent>
            </Card>
        </div>
    );
}

// Its own component, so it reads whether Complete setup was pressed.
function SetupFieldset({
    fields,
    onChange,
    mailDomain,
    storagePicker,
}: {
    fields: SetupFields;
    onChange: (patch: Partial<SetupFields>) => void;
    mailDomain: string;
    storagePicker: ReactNode;
}) {
    const submitted = useFormSubmitted();
    const problems = problemsOf(fields);
    // A wrong sender or username shows as it is typed, a missing value only once Complete setup was pressed.
    const shown = (field: keyof SetupFields) =>
        submitted || (LIVE.has(field) && fields[field] !== '') ? problems[field] : undefined;
    const note = (field: keyof SetupFields) => {
        const problem = shown(field);
        const id = `${field}-note`;
        const text = problem ?? HINTS[field];
        return {
            input: { 'aria-invalid': !!problem || undefined, 'aria-describedby': text ? id : undefined },
            line: problem ? (
                <FieldError id={id} className="mt-1">
                    {problem}
                </FieldError>
            ) : (
                text && (
                    <p id={id} className="text-xs text-muted-foreground mt-1">
                        {text}
                    </p>
                )
            ),
        };
    };
    const orgName = note('orgName');
    const senderAddress = note('senderAddress');
    const adminName = note('adminName');
    const adminUsername = note('adminUsername');
    const adminPassword = note('adminPassword');

    return (
        <>
            <div className="space-y-4">
                <h3 className="font-medium text-lg">Server configuration</h3>

                <div>
                    <Label htmlFor="orgName">Organization name</Label>
                    <Input
                        id="orgName"
                        value={fields.orgName}
                        onChange={(e) => onChange({ orgName: e.target.value.trimStart() })}
                        placeholder={ORG_NAME_PLACEHOLDER}
                        className="mt-1.5"
                        {...orgName.input}
                    />
                    {orgName.line}
                </div>

                <div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <Label htmlFor="senderName">Sender name</Label>
                            <Input
                                id="senderName"
                                value={fields.senderName}
                                onChange={(e) => onChange({ senderName: e.target.value })}
                                placeholder={fields.orgName.trim() || ORG_NAME_PLACEHOLDER}
                                maxLength={100}
                                className="mt-1.5"
                            />
                        </div>
                        <div>
                            <Label htmlFor="senderAddress">Sender address</Label>
                            <Input
                                id="senderAddress"
                                type="email"
                                value={fields.senderAddress}
                                onChange={(e) => onChange({ senderAddress: e.target.value.trim() })}
                                className="mt-1.5"
                                {...senderAddress.input}
                            />
                        </div>
                    </div>
                    {senderAddress.line}
                </div>

                {storagePicker}
            </div>

            <div className="space-y-4 pt-6 border-t">
                <h3 className="font-medium text-lg">Admin account</h3>

                <div>
                    <Label htmlFor="adminName">Full name</Label>
                    <Input
                        id="adminName"
                        value={fields.adminName}
                        onChange={(e) => onChange({ adminName: e.target.value })}
                        className="mt-1.5"
                        {...adminName.input}
                    />
                    {adminName.line}
                </div>

                <div>
                    <Label htmlFor="adminUsername">Username</Label>
                    <InputGroup className="mt-1.5">
                        <InputGroupInput
                            id="adminUsername"
                            value={fields.adminUsername}
                            onChange={(e) => onChange({ adminUsername: e.target.value })}
                            placeholder="jane"
                            autoComplete="off"
                            {...adminUsername.input}
                        />
                        <InputGroupAddon align="inline-end">
                            <InputGroupText>@{mailDomain}</InputGroupText>
                        </InputGroupAddon>
                    </InputGroup>
                    {adminUsername.line}
                </div>

                <div>
                    <Label htmlFor="adminPassword">Password</Label>
                    <Input
                        id="adminPassword"
                        type="password"
                        autoComplete="new-password"
                        value={fields.adminPassword}
                        onChange={(e) => onChange({ adminPassword: e.target.value })}
                        className="mt-1.5"
                        {...adminPassword.input}
                    />
                    {adminPassword.line}
                </div>
            </div>
        </>
    );
}

const LIVE: ReadonlySet<keyof SetupFields> = new Set(['senderAddress', 'adminUsername']);

// The line under a field while nothing is wrong with it.
const HINTS: Partial<Record<keyof SetupFields, string>> = {
    senderAddress:
        'Notifications, codes and invitations are sent from this address. Your mail relay must be allowed to send from it.',
    adminUsername: 'You sign in with this address',
    adminPassword: `At least ${MIN_PASSWORD_LENGTH} characters`,
};

const usernameOf = (fields: SetupFields) => fields.adminUsername.trim().toLowerCase();

function problemsOf(fields: SetupFields): Partial<Record<keyof SetupFields, string>> {
    const username = usernameOf(fields);
    return {
        orgName: fields.orgName ? undefined : FIELD_MESSAGES.nameMissing,
        senderAddress: validateEmailAddress(fields.senderAddress) ? undefined : FIELD_MESSAGES.invalidEmail,
        adminName: fields.adminName.trim() ? undefined : 'Add your name',
        adminUsername: username ? (validateUsername(username) ?? undefined) : 'Add a username',
        adminPassword: fields.adminPassword.length < MIN_PASSWORD_LENGTH ? FIELD_MESSAGES.passwordTooShort : undefined,
    };
}
