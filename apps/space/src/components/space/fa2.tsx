// The steps of Space's two-factor page: turning it on (confirm the password, scan the QR code or type the key into an
// authenticator app, check a code, save the backup codes) and the form that turns it off again. The page keeps which
// step shows, and each step's form sends its own request. A wrong code reads under its field, and leaving the codes
// step asks first, since those codes show only once.

import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { getErrorMessage } from '@workspace/lib/api-error';
import { isWrongCode, useDisable2FA, useInitialize2FA, useVerifyTotp } from '@workspace/lib/auth';
import { Button } from '@workspace/ui/components/button';
import { Card, CardContent } from '@workspace/ui/components/card';
import { CopyInput } from '@workspace/ui/components/copy-input';
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
import { LeaveGuard } from '@workspace/ui/components/layout/app';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import { Check, Copy, InfoIcon } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

const passwordSchema = z.object({
    password: z.string().min(1, 'Password is required'),
});

const verificationSchema = z.object({
    verificationCode: z
        .string()
        .min(6, 'Verification code must be 6 digits')
        .max(6, 'Verification code must be 6 digits'),
});

export type TwoFactorSecret = { totpURI: string; backupCodes: string[] };

export function TwoFactorPasswordStep({ onEnabled }: { onEnabled: (secret: TwoFactorSecret) => void }) {
    const initialize2FA = useInitialize2FA();
    const { pending, run } = useDialogPending();
    const form = useForm<z.infer<typeof passwordSchema>>({
        resolver: zodResolver(passwordSchema),
        defaultValues: { password: '' },
    });

    const onSubmit = form.handleSubmit(async ({ password }) => {
        onEnabled(await initialize2FA.mutateAsync(password));
    });

    return (
        <Form {...form}>
            <FormShell focusesOwnErrors autoFocus className="space-y-6" onSubmit={() => run(onSubmit)}>
                <Notice title="Important">
                    Two-factor authentication adds an extra layer of security to your account. Once enabled, you'll need
                    both your password and a verification code from your authentication app to sign in.
                </Notice>

                <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Current password</FormLabel>
                            <FormControl>
                                <Input
                                    type="password"
                                    placeholder="Enter current password"
                                    autoComplete="current-password"
                                    {...field}
                                />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <div className="flex justify-end gap-3">
                    <Button type="submit" pending={pending}>
                        Enable two-factor authentication
                    </Button>
                </div>
            </FormShell>
        </Form>
    );
}

export function TwoFactorQrStep({
    totpURI,
    onBack,
    onContinue,
}: {
    totpURI: string;
    onBack: () => void;
    onContinue: () => void;
}) {
    return (
        <div className="space-y-6">
            <Notice title="Set up authenticator app">
                Scan the QR code below with your authenticator app (like Google Authenticator, Authy, or Microsoft
                Authenticator) to set up two-factor authentication.
            </Notice>

            <div className="space-y-4">
                <h3 className="text-lg font-medium">Step 1: Scan QR code</h3>
                <p className="text-sm text-muted-foreground">Scan this QR code with your authentication app.</p>

                <Card className="border-dashed">
                    <CardContent className="flex items-center justify-center p-6">
                        <div className="w-48 h-48 flex items-center justify-center">
                            <QRCodeSVG value={totpURI} size={192} />
                        </div>
                    </CardContent>
                </Card>
            </div>

            <div className="space-y-4">
                <h3 className="text-lg font-medium">Step 2: Or enter setup key manually</h3>
                <p className="text-sm text-muted-foreground">
                    If you can't scan the QR code, you can manually enter this setup key into your app.
                </p>

                <CopyInput
                    value={new URL(totpURI).searchParams.get('secret') ?? ''}
                    successMessage="Setup key copied to clipboard"
                />
            </div>

            <div className="flex justify-between">
                <Button variant="outline" onClick={onBack}>
                    Back
                </Button>
                <Button onClick={onContinue}>Continue</Button>
            </div>
        </div>
    );
}

export function TwoFactorVerifyStep({ onBack, onVerified }: { onBack: () => void; onVerified: () => void }) {
    const verifyTotp = useVerifyTotp();
    const { pending, run } = useDialogPending();
    const form = useForm<z.infer<typeof verificationSchema>>({
        resolver: zodResolver(verificationSchema),
        defaultValues: { verificationCode: '' },
    });

    const onSubmit = form.handleSubmit(async ({ verificationCode }) => {
        try {
            await verifyTotp.mutateAsync({ code: verificationCode });
        } catch (error) {
            if (!isWrongCode(error)) throw error;
            form.setError('verificationCode', { message: getErrorMessage(error) }, { shouldFocus: true });
            return;
        }
        onVerified();
    });

    return (
        <Form {...form}>
            <FormShell focusesOwnErrors autoFocus className="space-y-6" onSubmit={() => run(onSubmit)}>
                <Notice title="Verify your setup">
                    Enter the 6-digit verification code from your authenticator app to complete the setup.
                </Notice>

                <FormField
                    control={form.control}
                    name="verificationCode"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Verification code</FormLabel>
                            <FormControl>
                                <Input
                                    placeholder="Enter 6-digit code"
                                    {...field}
                                    maxLength={6}
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                />
                            </FormControl>
                            <FormDescription>Enter the 6-digit code from your authentication app</FormDescription>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <div className="flex justify-between gap-3">
                    <Button type="button" variant="outline" onClick={onBack} disabled={pending}>
                        Back
                    </Button>
                    <Button type="submit" pending={pending}>
                        Verify and enable
                    </Button>
                </div>
            </FormShell>
        </Form>
    );
}

export function TwoFactorCodesStep({ backupCodes }: { backupCodes: readonly string[] }) {
    const navigate = useNavigate();
    const [codesCopied, setCodesCopied] = useState(false);

    const copyBackupCodes = () => {
        navigator.clipboard.writeText(backupCodes.join('\n'));
        setCodesCopied(true);
        setTimeout(() => setCodesCopied(false), 2000);
    };

    return (
        <div className="space-y-6">
            <Notice title="Save your recovery codes">
                Save these codes in a safe place. If you lose access to your authenticator app, you can use one of these
                codes to sign in. Each code can only be used once.
            </Notice>

            <Card>
                <CardContent className="p-4">
                    <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                        {backupCodes.map((code) => (
                            <div key={code} className="px-3 py-2 bg-muted rounded-md text-center">
                                {code}
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>

            <Button variant="outline" className="w-full" onClick={copyBackupCodes}>
                {codesCopied ? (
                    <>
                        <Check className="h-4 w-4 mr-2" />
                        Copied!
                    </>
                ) : (
                    <>
                        <Copy className="h-4 w-4 mr-2" />
                        Copy all codes
                    </>
                )}
            </Button>

            <p className="text-sm text-muted-foreground text-center">
                Store these codes somewhere safe, like a password manager. You won't be able to see them again.
            </p>

            <Button className="w-full" onClick={() => navigate({ to: '/', ignoreBlocker: true })}>
                I've saved my recovery codes
            </Button>

            <LeaveGuard active question={LEAVE_CODES_QUESTION} />
        </div>
    );
}

const LEAVE_CODES_QUESTION = {
    title: 'Leave without your recovery codes?',
    description: "These codes show only once. Without them you can't sign in if you lose your authenticator app.",
    cancelText: 'Stay',
    confirmText: 'Leave',
};

// The form behind "Disable two-factor authentication", which asks for the password first.
export function TwoFactorDisable({ onDisabled }: { onDisabled: () => void }) {
    const disable2FA = useDisable2FA();
    const { pending, run } = useDialogPending();
    const [open, setOpen] = useState(false);
    const form = useForm<z.infer<typeof passwordSchema>>({
        resolver: zodResolver(passwordSchema),
        defaultValues: { password: '' },
    });

    const close = () => {
        setOpen(false);
        form.reset();
    };

    const onSubmit = form.handleSubmit(async ({ password }) => {
        await disable2FA.mutateAsync(password);
        close();
        onDisabled();
    });

    if (!open) {
        return (
            <Button variant="destructive" onClick={() => setOpen(true)}>
                Disable two-factor authentication
            </Button>
        );
    }

    return (
        <Form {...form}>
            <FormShell focusesOwnErrors autoFocus className="space-y-4 max-w-sm" onSubmit={() => run(onSubmit)}>
                <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Confirm your password</FormLabel>
                            <FormControl>
                                <Input
                                    type="password"
                                    placeholder="Enter current password"
                                    autoComplete="current-password"
                                    {...field}
                                />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <div className="flex gap-3">
                    <Button type="button" variant="outline" onClick={close} disabled={pending}>
                        Cancel
                    </Button>
                    <Button type="submit" variant="destructive" pending={pending}>
                        Disable
                    </Button>
                </div>
            </FormShell>
        </Form>
    );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="bg-accent border text-accent-foreground rounded-md p-4">
            <div className="flex">
                <InfoIcon className="h-5 w-5 text-primary mr-2" />
                <div>
                    <h3 className="font-medium">{title}</h3>
                    <p className="text-sm">{children}</p>
                </div>
            </div>
        </div>
    );
}
