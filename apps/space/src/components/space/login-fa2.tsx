import { zodResolver } from '@hookform/resolvers/zod';
import { getRouteApi } from '@tanstack/react-router';
import { useVerifyBackupCode, useVerifyTotp } from '@workspace/lib/auth';
import { Bar, Ket, useApp } from '@workspace/ui';
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
import { Input } from '@workspace/ui/components/input';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

const totpSchema = z.object({
    code: z.string().min(6, 'Code must be 6 digits').max(6, 'Code must be 6 digits'),
    trustDevice: z.boolean(),
});

const backupSchema = z.object({
    code: z.string().min(1, 'Backup code is required'),
    trustDevice: z.boolean(),
});

const route = getRouteApi('/login-2fa');

export default function LoginFa2Page() {
    const { appName } = useApp();
    const { redirect } = route.useSearch();
    const [mode, setMode] = useState<'totp' | 'backup'>('totp');

    const verifyTotp = useVerifyTotp();
    const verifyBackupCode = useVerifyBackupCode();
    const isLoading = verifyTotp.isPending || verifyBackupCode.isPending;

    const totpForm = useForm<z.infer<typeof totpSchema>>({
        resolver: zodResolver(totpSchema),
        defaultValues: { code: '', trustDevice: false },
    });

    const backupForm = useForm<z.infer<typeof backupSchema>>({
        resolver: zodResolver(backupSchema),
        defaultValues: { code: '', trustDevice: false },
    });

    async function onTotpSubmit(values: z.infer<typeof totpSchema>) {
        const data = await verifyTotp.mutateAsync({ code: values.code, trustDevice: values.trustDevice });
        if (data) window.location.href = redirect || '/';
    }

    async function onBackupSubmit(values: z.infer<typeof backupSchema>) {
        const data = await verifyBackupCode.mutateAsync({ code: values.code, trustDevice: values.trustDevice });
        if (data) window.location.href = redirect || '/';
    }

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
                    {mode === 'totp' ? (
                        <Form {...totpForm}>
                            <form onSubmit={totpForm.handleSubmit(onTotpSubmit)} className="space-y-6">
                                <FormField
                                    control={totpForm.control}
                                    name="code"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Verification Code</FormLabel>
                                            <FormControl>
                                                <Input
                                                    placeholder="Enter 6-digit code"
                                                    {...field}
                                                    maxLength={6}
                                                    inputMode="numeric"
                                                    pattern="[0-9]*"
                                                    autoComplete="one-time-code"
                                                    autoFocus
                                                />
                                            </FormControl>
                                            <FormDescription>
                                                Enter the code from your authenticator app
                                            </FormDescription>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />

                                <FormField
                                    control={totpForm.control}
                                    name="trustDevice"
                                    render={({ field }) => (
                                        <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                                            <FormControl>
                                                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                                            </FormControl>
                                            <div className="space-y-1 leading-none">
                                                <FormLabel>Trust this device</FormLabel>
                                                <FormDescription>
                                                    Don't ask for verification on this device for 30 days
                                                </FormDescription>
                                            </div>
                                        </FormItem>
                                    )}
                                />

                                <Button type="submit" className="w-full" disabled={isLoading}>
                                    {isLoading ? 'Verifying...' : 'Verify'}
                                </Button>

                                <div className="text-center">
                                    <Button type="button" variant="link" size="sm" onClick={() => setMode('backup')}>
                                        Use a backup code instead
                                    </Button>
                                </div>
                            </form>
                        </Form>
                    ) : (
                        <Form {...backupForm}>
                            <form onSubmit={backupForm.handleSubmit(onBackupSubmit)} className="space-y-6">
                                <FormField
                                    control={backupForm.control}
                                    name="code"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Backup Code</FormLabel>
                                            <FormControl>
                                                <Input
                                                    placeholder="Enter backup code"
                                                    {...field}
                                                    autoComplete="off"
                                                    autoFocus
                                                />
                                            </FormControl>
                                            <FormDescription>Enter one of your saved recovery codes</FormDescription>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />

                                <FormField
                                    control={backupForm.control}
                                    name="trustDevice"
                                    render={({ field }) => (
                                        <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                                            <FormControl>
                                                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                                            </FormControl>
                                            <div className="space-y-1 leading-none">
                                                <FormLabel>Trust this device</FormLabel>
                                                <FormDescription>
                                                    Don't ask for verification on this device for 30 days
                                                </FormDescription>
                                            </div>
                                        </FormItem>
                                    )}
                                />

                                <Button type="submit" className="w-full" disabled={isLoading}>
                                    {isLoading ? 'Verifying...' : 'Verify with backup code'}
                                </Button>

                                <div className="text-center">
                                    <Button type="button" variant="link" size="sm" onClick={() => setMode('totp')}>
                                        Use authenticator app instead
                                    </Button>
                                </div>
                            </form>
                        </Form>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
