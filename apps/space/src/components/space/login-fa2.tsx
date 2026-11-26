// The second sign-in step for a user with two-factor authentication: a code from their app, or one of their
// backup codes, each its own form, so switching opens the other on its field. A wrong code reads under the field;
// any other refusal is its hook's toast. After it, the user goes back to the page that sent them to sign in. A sign-in
// that expired before its code came starts over at the password, with the same way back.

import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { getErrorMessage } from '@workspace/lib/api-error';
import { isExpiredSignIn, isWrongCode, loadIntoSession, useVerifyBackupCode, useVerifyTotp } from '@workspace/lib/auth';
import { Bar, Ket } from '@workspace/ui/components/braket';
import { Button } from '@workspace/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { Checkbox } from '@workspace/ui/components/checkbox';
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from '@workspace/ui/components/form';
import { FormShell } from '@workspace/ui/components/form-shell';
import { Input } from '@workspace/ui/components/input';
import { useApp } from '@workspace/ui/components/layout/app';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

type Mode = 'totp' | 'backup';

const MODES = {
    totp: {
        schema: z.object({
            code: z.string().min(6, 'Code must be 6 digits').max(6, 'Code must be 6 digits'),
            trustDevice: z.boolean(),
        }),
        label: 'Verification code',
        placeholder: 'Enter 6-digit code',
        description: 'Enter the code from your authenticator app',
        input: { maxLength: 6, inputMode: 'numeric', pattern: '[0-9]*', autoComplete: 'one-time-code' },
        submitLabel: 'Verify',
        switchLabel: 'Use a backup code instead',
        other: 'backup',
    },
    backup: {
        schema: z.object({ code: z.string().min(1, 'Backup code is required'), trustDevice: z.boolean() }),
        label: 'Backup code',
        placeholder: 'Enter backup code',
        description: 'Enter one of your saved recovery codes',
        input: { autoComplete: 'off' },
        submitLabel: 'Verify with backup code',
        switchLabel: 'Use authenticator app instead',
        other: 'totp',
    },
} as const;

type CodeValues = { code: string; trustDevice: boolean };

// `redirect` is the page that sent the user to sign in.
export function LoginFa2Page({ redirect }: { redirect?: string }) {
    const { appName } = useApp();
    const [mode, setMode] = useState<Mode>('totp');

    return (
        <div className="flex w-full h-[calc(100vh-64px)] items-center justify-center">
            <Card className="w-full max-w-md">
                <CardHeader className="text-center">
                    <CardTitle className="text-2xl">
                        <span className="font-medium">eigen</span>
                        <span className="font-normal text-app">
                            <Bar />
                            {appName}
                            <Ket />
                        </span>
                    </CardTitle>
                    <CardDescription>Your account is protected with two-factor authentication</CardDescription>
                </CardHeader>
                <CardContent>
                    <CodeForm key={mode} mode={mode} redirect={redirect} onSwitch={() => setMode(MODES[mode].other)} />
                </CardContent>
            </Card>
        </div>
    );
}

function CodeForm({ mode, redirect, onSwitch }: { mode: Mode; redirect?: string; onSwitch: () => void }) {
    const verifyTotp = useVerifyTotp();
    const verifyBackupCode = useVerifyBackupCode();
    const verify = mode === 'totp' ? verifyTotp : verifyBackupCode;
    const { schema, label, placeholder, description, input, submitLabel, switchLabel } = MODES[mode];
    const { pending, run } = useDialogPending();
    const navigate = useNavigate();

    const form = useForm<CodeValues>({
        resolver: zodResolver(schema),
        defaultValues: { code: '', trustDevice: false },
    });

    const onSubmit = form.handleSubmit(async (values) => {
        try {
            await verify.mutateAsync(values);
        } catch (error) {
            if (isExpiredSignIn(error)) {
                await navigate({ to: '/login', search: { redirect } });
                return;
            }
            if (!isWrongCode(error)) throw error;
            form.setError('code', { message: getErrorMessage(error) }, { shouldFocus: true });
            return;
        }
        await loadIntoSession(redirect || '/');
    });

    return (
        <Form {...form}>
            <FormShell autoFocus className="space-y-6" onSubmit={() => run(onSubmit)}>
                <FormField
                    control={form.control}
                    name="code"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>{label}</FormLabel>
                            <FormControl>
                                <Input placeholder={placeholder} {...field} {...input} />
                            </FormControl>
                            <FormDescription>{description}</FormDescription>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="trustDevice"
                    render={({ field }) => (
                        <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                            <FormControl>
                                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                            </FormControl>
                            <div className="space-y-1 leading-none">
                                <FormLabel>Trust this device</FormLabel>
                                <FormDescription>Don't ask for verification on this device for 30 days</FormDescription>
                            </div>
                        </FormItem>
                    )}
                />

                <Button type="submit" className="w-full" pending={pending}>
                    {submitLabel}
                </Button>

                <div className="text-center">
                    <Button type="button" variant="link" size="sm" onClick={onSwitch}>
                        {switchLabel}
                    </Button>
                </div>
            </FormShell>
        </Form>
    );
}
