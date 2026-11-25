// The sign-in page every app shows a visitor with no session: a member signs in with username and password, a guest
// asks for a one-time code by email and types it in. Each form goes through its sign-in hook. A refusal of what was
// typed shows under the field it is about, in the server's own words where it gave some; a rate limit, a server error
// or no connection is the hook's toast.

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from '@tanstack/react-router';
import { getDemoEnterUrl } from '@workspace/lib/api';
import { getErrorMessage } from '@workspace/lib/api-error';
import {
    isRefusedAddress,
    isRefusedCode,
    isRefusedCredentials,
    loadIntoSession,
    useAuth,
    usePasswordSignIn,
    useRequestGuestCode,
    useVerifyGuestCode,
} from '@workspace/lib/auth';
import { usePublicConfig } from '@workspace/lib/public';
import { FIELD_MESSAGES, validateEmailAddress } from '@workspace/lib/validation';
import type { MouseEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { FieldValues, UseFormReturn } from 'react-hook-form';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDialogPending } from '../../../hooks/use-dialog-pending';
import { Bar } from '../../braket/bar';
import { Ket } from '../../braket/ket';
import { Button } from '../../button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../card';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '../../form';
import { FormShell } from '../../form-shell';
import { Input } from '../../input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../../input-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../tabs';
import { useApp } from '../app/layout-context';

const loginFormSchema = z.object({
    email: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
});

const guestEmailSchema = z.object({
    email: z.string().refine(validateEmailAddress, FIELD_MESSAGES.invalidEmail),
});

const guestCodeSchema = z.object({
    otp: z.string().min(6, 'Code must be 6 digits'),
});

export function LoginPage({ email: initialEmail }: { email?: string } = {}) {
    const { appName } = useApp();
    const { data: config, isPending: isConfigPending } = usePublicConfig();

    // A demo box hands every visitor a seeded persona, so its card holds only the entry button.
    const demoMode = config?.demoMode ?? false;

    // Empty until the config answers, so a demo box never flashes the password form.
    let formContent: ReactNode = null;
    if (!isConfigPending) {
        if (demoMode) {
            formContent = (
                <Button asChild className="w-full">
                    <a href={getDemoEnterUrl()}>Enter demo</a>
                </Button>
            );
        } else {
            formContent = (
                <Tabs defaultValue={initialEmail ? 'guest' : 'signin'}>
                    <TabsList className="w-full mb-6">
                        <TabsTrigger
                            value="signin"
                            className="flex-1"
                            onMouseDown={focusPanelField}
                            onClick={focusPanelField}
                        >
                            Sign in
                        </TabsTrigger>
                        <TabsTrigger
                            value="guest"
                            className="flex-1"
                            onMouseDown={focusPanelField}
                            onClick={focusPanelField}
                        >
                            Guest
                        </TabsTrigger>
                    </TabsList>
                    <TabsContent value="signin">
                        <PasswordLoginForm />
                    </TabsContent>
                    <TabsContent value="guest">
                        <GuestLoginForm initialEmail={initialEmail} />
                    </TabsContent>
                </Tabs>
            );
        }
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
                    {!isConfigPending && (
                        <CardDescription>
                            {demoMode ? 'Explore a shared demo workspace.' : 'Sign in to access your account'}
                        </CardDescription>
                    )}
                </CardHeader>

                <CardContent>{formContent}</CardContent>
            </Card>
        </div>
    );
}

// A press on a tab mounts its panel, whose autoFocus field then loses the focus to the tab the browser focuses for the
// press. The click that follows may never reach the tab, since the card centers on the new panel's height and moves
// away from the pointer, so the press itself hands the focus on, a task later. The click does it for Enter and Space.
function focusPanelField(event: MouseEvent<HTMLButtonElement>) {
    const panelId = event.currentTarget.getAttribute('aria-controls') ?? '';
    setTimeout(() => document.getElementById(panelId)?.querySelector('input')?.focus());
}

function PasswordLoginForm() {
    const { isAuthenticated } = useAuth();
    const signIn = usePasswordSignIn();
    const router = useRouter();
    const { data: config } = usePublicConfig();
    const loginDomain = config?.mailDomain ?? window.location.hostname;

    const form = useForm<z.infer<typeof loginFormSchema>>({
        resolver: zodResolver(loginFormSchema),
        defaultValues: { email: '', password: '' },
    });

    const onSubmit = async ({ email, password }: z.infer<typeof loginFormSchema>) => {
        try {
            await signIn.mutateAsync({ email: `${email.toLowerCase().split('@')[0]}@${loginDomain}`, password });
        } catch (error) {
            if (!isRefusedCredentials(error)) throw error;
            form.setError('password', { message: getErrorMessage(error) }, { shouldFocus: true });
        }
    };

    useEffect(() => {
        if (isAuthenticated) {
            router.invalidate();
        }
    }, [isAuthenticated, router]);

    return (
        <SignInForm form={form} onSubmit={onSubmit} submitLabel="Sign in">
            <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                    <FormItem>
                        <FormLabel>Username</FormLabel>
                        <InputGroup>
                            <FormControl>
                                <InputGroupInput placeholder="username" autoFocus {...field} />
                            </FormControl>
                            <InputGroupAddon align="inline-end">
                                <InputGroupText>@{loginDomain}</InputGroupText>
                            </InputGroupAddon>
                        </InputGroup>
                        <FormMessage />
                    </FormItem>
                )}
            />

            <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                    <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                            <Input type="password" {...field} />
                        </FormControl>
                        <FormMessage />
                    </FormItem>
                )}
            />
        </SignInForm>
    );
}

// The form and its full-width submit button, which spins while the sign-in runs. A second Enter or Cmd+Enter in that
// time sends nothing. A failure its hook toasted ends here.
function SignInForm<Values extends FieldValues>({
    form,
    onSubmit,
    submitLabel,
    children,
}: {
    form: UseFormReturn<Values>;
    onSubmit: (values: Values) => Promise<void>;
    submitLabel: string;
    children: ReactNode;
}) {
    const { pending, run } = useDialogPending();
    return (
        <Form {...form}>
            <FormShell className="space-y-6" onSubmit={() => run(form.handleSubmit(onSubmit))}>
                {children}
                <Button type="submit" className="w-full" pending={pending}>
                    {submitLabel}
                </Button>
            </FormShell>
        </Form>
    );
}

// The address the code went to is what the code step sends with it.
function GuestLoginForm({ initialEmail }: { initialEmail?: string }) {
    const [sentTo, setSentTo] = useState<string | null>(null);
    return sentTo === null ? (
        <GuestEmailForm initialEmail={initialEmail} onSent={setSentTo} />
    ) : (
        <GuestCodeForm email={sentTo} />
    );
}

function GuestEmailForm({ initialEmail = '', onSent }: { initialEmail?: string; onSent: (email: string) => void }) {
    const form = useForm<z.infer<typeof guestEmailSchema>>({
        resolver: zodResolver(guestEmailSchema),
        defaultValues: { email: initialEmail },
    });

    const requestCode = useRequestGuestCode();

    const onSubmit = async ({ email }: z.infer<typeof guestEmailSchema>) => {
        try {
            await requestCode.mutateAsync(email);
        } catch (error) {
            if (!isRefusedAddress(error)) throw error;
            form.setError('email', { message: getErrorMessage(error) }, { shouldFocus: true });
            return;
        }
        onSent(email);
    };

    return (
        <SignInForm form={form} onSubmit={onSubmit} submitLabel="Send code">
            <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                    <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                            <Input type="email" placeholder="you@example.com" autoFocus {...field} />
                        </FormControl>
                        <FormMessage />
                    </FormItem>
                )}
            />
        </SignInForm>
    );
}

function GuestCodeForm({ email }: { email: string }) {
    const form = useForm<z.infer<typeof guestCodeSchema>>({
        resolver: zodResolver(guestCodeSchema),
        defaultValues: { otp: '' },
    });

    const verifyCode = useVerifyGuestCode();

    const onSubmit = async ({ otp }: z.infer<typeof guestCodeSchema>) => {
        try {
            await verifyCode.mutateAsync({ email, otp });
        } catch (error) {
            if (!isRefusedCode(error)) throw error;
            form.setError('otp', { message: getErrorMessage(error) }, { shouldFocus: true });
            return;
        }
        await loadIntoSession();
    };

    return (
        <SignInForm form={form} onSubmit={onSubmit} submitLabel="Verify">
            <FormField
                control={form.control}
                name="otp"
                render={({ field }) => (
                    <FormItem>
                        <FormLabel>One-time code</FormLabel>
                        <FormControl>
                            <Input
                                type="text"
                                inputMode="numeric"
                                placeholder="123456"
                                maxLength={6}
                                autoFocus
                                {...field}
                            />
                        </FormControl>
                        <FormDescription>
                            Check your email for the 6-digit code. If you asked for more than one, use the newest.
                        </FormDescription>
                        <FormMessage />
                    </FormItem>
                )}
            />
        </SignInForm>
    );
}
