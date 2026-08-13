import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from '@tanstack/react-router';
import { API_HOST, getDemoEnterUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth/auth-context.tsx';
import { usePublicConfig } from '@workspace/lib/public';
import { validateEmailAddress } from '@workspace/lib/validation';
import { type ReactNode, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Bar } from '../../braket/bar.tsx';
import { Ket } from '../../braket/ket.tsx';
import { Button } from '../../button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../card.tsx';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '../../form.tsx';
import { Input } from '../../input.tsx';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../../input-group.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../tabs.tsx';
import { useApp } from '../app/layout-context.tsx';

const loginFormSchema = z.object({
    email: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
});

type LoginFormValues = z.infer<typeof loginFormSchema>;

function PasswordLoginForm() {
    const { login, isAuthenticated } = useAuth();
    const router = useRouter();
    const { data: config, isPending: isConfigPending } = usePublicConfig();
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const form = useForm<LoginFormValues>({
        resolver: zodResolver(loginFormSchema),
        defaultValues: {
            email: '',
            password: '',
        },
    });

    const onSubmit = async (values: LoginFormValues) => {
        setIsLoading(true);
        setError('');

        const loginDomain = config?.mailDomain ?? window.location.hostname;
        values.email = `${values.email.toLowerCase().split('@')[0]}@${loginDomain}`;

        try {
            const { success, error } = await login(values.email, values.password);

            if (!success && error) {
                const errorMessage = error instanceof Error ? error.message : 'Login failed';
                setError(errorMessage);
            }
        } catch (_err) {
            setError('An unexpected error occurred');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (isAuthenticated) {
            router.invalidate();
        }
    }, [isAuthenticated, router]);

    return (
        <>
            {error && <div className="p-3 mb-4 text-sm text-destructive bg-destructive/10 rounded-md">{error}</div>}

            <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                    <FormField
                        control={form.control}
                        name="email"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Username</FormLabel>
                                <FormControl>
                                    <InputGroup>
                                        <InputGroupInput placeholder="username" autoFocus {...field} />
                                        <InputGroupAddon align="inline-end">
                                            <InputGroupText>
                                                @{config?.mailDomain ?? window.location.hostname}
                                            </InputGroupText>
                                        </InputGroupAddon>
                                    </InputGroup>
                                </FormControl>
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

                    <Button type="submit" className="w-full" disabled={isLoading || isConfigPending}>
                        {isLoading ? 'Signing in...' : 'Sign in'}
                    </Button>
                </form>
            </Form>
        </>
    );
}

function GuestLoginForm({ initialEmail = '' }: { initialEmail?: string }) {
    const [email, setEmail] = useState(initialEmail);
    const [otp, setOtp] = useState('');
    const [step, setStep] = useState<'email' | 'otp'>('email');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const isEmailValid = validateEmailAddress(email);

    const handleRequestOtp = async () => {
        setIsLoading(true);
        setError('');
        try {
            const res = await fetch(`${API_HOST}/guest-auth/request-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
            if (!res.ok) {
                setError((await res.text()) || 'Failed to send code');
                return;
            }
            setStep('otp');
        } catch {
            setError('Failed to send code');
        } finally {
            setIsLoading(false);
        }
    };

    const handleVerifyOtp = async () => {
        setIsLoading(true);
        setError('');
        try {
            const res = await fetch(`${API_HOST}/guest-auth/verify-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ email, otp }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.message ?? 'Verification failed');
                return;
            }
            window.location.reload();
        } catch {
            setError('Verification failed');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="space-y-6">
            {error && <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">{error}</div>}

            {step === 'email' ? (
                <>
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Email</label>
                        <Input
                            type="email"
                            placeholder="you@example.com"
                            autoFocus
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && isEmailValid && handleRequestOtp()}
                        />
                    </div>
                    <Button className="w-full" disabled={isLoading || !isEmailValid} onClick={handleRequestOtp}>
                        {isLoading ? 'Sending...' : 'Send code'}
                    </Button>
                </>
            ) : (
                <>
                    <div className="space-y-2">
                        <label className="text-sm font-medium">One-time code</label>
                        <Input
                            type="text"
                            inputMode="numeric"
                            placeholder="123456"
                            maxLength={6}
                            autoFocus
                            value={otp}
                            onChange={(e) => setOtp(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleVerifyOtp()}
                        />
                        <p className="text-xs text-muted-foreground">Check your email for the 6-digit code.</p>
                    </div>
                    <Button className="w-full" disabled={isLoading || otp.length < 6} onClick={handleVerifyOtp}>
                        {isLoading ? 'Verifying...' : 'Verify'}
                    </Button>
                </>
            )}
        </div>
    );
}

export function LoginPage({ email: initialEmail }: { email?: string } = {}) {
    const { appName } = useApp();
    const { data: config, isPending: isConfigPending } = usePublicConfig();

    // Demo instances hand every visitor a random seeded persona — the login card is just the
    // entry button, no password sign-in. The box is reseeded hourly, so there's nothing to guard.
    const demoMode = config?.demoMode ?? false;

    // Hold the form area until config resolves — a demo box must not flash the credentials form.
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
                        <TabsTrigger value="signin" className="flex-1">
                            Sign in
                        </TabsTrigger>
                        <TabsTrigger value="guest" className="flex-1">
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
