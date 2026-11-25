// The sign-in page every app shows a visitor with no session: a member signs in with username and password, a guest
// asks for a one-time code by email and types it in. The password form goes through useAuth; the guest forms post to
// the public guest sign-in routes themselves. A refusal of what was typed shows under the field it is about, in the
// server's own words where it gave some; a rate limit, a server error or no connection is a toast.

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from '@tanstack/react-router';
import { API_HOST, getDemoEnterUrl } from '@workspace/lib/api';
import { AppError, appErrorFrom, getErrorMessage } from '@workspace/lib/api-error';
import { useAuth } from '@workspace/lib/auth';
import { isRecord } from '@workspace/lib/guards';
import { usePublicConfig } from '@workspace/lib/public';
import { validateEmailAddress } from '@workspace/lib/validation';
import type { MouseEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { FieldValues, Path, SubmitHandler, UseFormReturn } from 'react-hook-form';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
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
    email: z.string().refine(validateEmailAddress, 'This is not an email address'),
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
                        <TabsTrigger value="signin" className="flex-1" onClick={focusPanelField}>
                            Sign in
                        </TabsTrigger>
                        <TabsTrigger value="guest" className="flex-1" onClick={focusPanelField}>
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

// The press on a tab focuses the tab after its panel mounted, so the panel's autoFocus field loses it again.
function focusPanelField(event: MouseEvent<HTMLButtonElement>) {
    const panel = document.getElementById(event.currentTarget.getAttribute('aria-controls') ?? '');
    panel?.querySelector('input')?.focus();
}

function PasswordLoginForm() {
    const { login, isAuthenticated } = useAuth();
    const router = useRouter();
    const { data: config } = usePublicConfig();
    const loginDomain = config?.mailDomain ?? window.location.hostname;

    const form = useForm<z.infer<typeof loginFormSchema>>({
        resolver: zodResolver(loginFormSchema),
        defaultValues: { email: '', password: '' },
    });

    const onSubmit = async ({ email, password }: z.infer<typeof loginFormSchema>) => {
        const { success, error } = await login(`${email.toLowerCase().split('@')[0]}@${loginDomain}`, password);
        if (!success) showFailure(form, 'password', loginFailure(error), CREDENTIAL_STATUSES);
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

// Wrong credentials and an unverified email. A rate limit, a server error or no connection is no reason to retype them.
const CREDENTIAL_STATUSES = new Set([400, 401]);

// better-auth answers a refusal with a plain object, never an Error; better-fetch throws when there is no connection.
function loginFailure(error: unknown): AppError | string {
    if (!isRecord(error) || typeof error.status !== 'number') return 'Login failed';
    return new AppError({ status: error.status, error: { status: error.status, value: error } });
}

// A no to what was typed reads under its field. Any other failure is a toast that marks no field, since typing it again
// gets the same answer.
function showFailure<Values extends FieldValues>(
    form: UseFormReturn<Values>,
    name: Path<Values>,
    failure: AppError | string,
    fieldStatuses: ReadonlySet<number>,
) {
    if (failure instanceof AppError && fieldStatuses.has(failure.status)) {
        form.setError(name, { message: failure.message }, { shouldFocus: true });
    } else {
        toast.error(getErrorMessage(failure));
    }
}

// The form and its full-width submit button, which spins while the sign-in runs. A second Enter or Cmd+Enter in that
// time sends nothing.
function SignInForm<Values extends FieldValues>({
    form,
    onSubmit,
    submitLabel,
    children,
}: {
    form: UseFormReturn<Values>;
    onSubmit: SubmitHandler<Values>;
    submitLabel: string;
    children: ReactNode;
}) {
    const { isSubmitting } = form.formState;
    return (
        <Form {...form}>
            <FormShell
                focusesOwnErrors
                className="space-y-6"
                onSubmit={async () => {
                    if (!isSubmitting) await form.handleSubmit(onSubmit)();
                }}
            >
                {children}
                <Button type="submit" className="w-full" pending={isSubmitting}>
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

    const onSubmit = async ({ email }: z.infer<typeof guestEmailSchema>) => {
        const failure = await postGuestAuth('request-otp', { email }, 'Failed to send code');
        if (failure) showFailure(form, 'email', failure, ADDRESS_STATUSES);
        else onSent(email);
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

    const onSubmit = async ({ otp }: z.infer<typeof guestCodeSchema>) => {
        const failure = await postGuestAuth('verify-otp', { email, otp }, 'Verification failed', 'include');
        if (failure) {
            showFailure(form, 'otp', failure, CODE_STATUSES);
            return;
        }
        window.location.reload();
        // The page goes only after this returns, so the button stays pending and a second Enter sends nothing.
        await new Promise<never>(() => {});
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

// An address that is no guest's or has nothing shared with it. A rate limit on asking is no reason to retype it.
const ADDRESS_STATUSES = new Set([400]);

// A wrong or expired code, and too many wrong tries (429), which only a new code gets past.
const CODE_STATUSES = new Set([400, 429]);

// Resolves the server's refusal, the offline sentence when no answer came, or null once the route took it.
// `credentials` lets the answer set the session cookie.
async function postGuestAuth(
    route: string,
    body: object,
    offline: string,
    credentials?: RequestCredentials,
): Promise<AppError | string | null> {
    try {
        const res = await fetch(`${API_HOST}/guest-auth/${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials,
            body: JSON.stringify(body),
        });
        return res.ok ? null : await appErrorFrom(res);
    } catch {
        return offline;
    }
}
