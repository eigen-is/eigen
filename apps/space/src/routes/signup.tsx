import { createFileRoute } from '@tanstack/react-router';
import { useInviteRegister, useValidateInviteToken } from '@workspace/lib/auth';
import { validateUsername } from '@workspace/lib/validation';
import { Bar, ErrorState, Ket, LoadingState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { Field, FieldContent, FieldGroup, FieldLabel } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@workspace/ui/components/input-group';
import { useState } from 'react';
import { z } from 'zod';

export const Route = createFileRoute('/signup')({
    component: SignupPage,
    validateSearch: z.object({
        token: z.string().optional().catch(undefined),
    }),
});

function SignupPage() {
    const { token } = Route.useSearch();
    const { data: invite, isLoading, isError } = useValidateInviteToken(token);
    const register = useInviteRegister(token ?? '');

    const [name, setName] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');

    if (!token) return <ErrorState message="No invite token provided" />;
    if (isLoading) return <LoadingState />;
    if (isError || !invite?.valid) {
        return <ErrorState message="This invite link is invalid or has expired" />;
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        const usernameError = validateUsername(username.toLowerCase());
        if (usernameError) {
            setError(usernameError);
            return;
        }

        if (password.length < 8) {
            setError('Password must be at least 8 characters');
            return;
        }

        if (password !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        await register.mutateAsync({
            name,
            username: username.toLowerCase(),
            password,
        });
        // Full page reload to pick up the new session cookie
        window.location.href = '/';
    };

    return (
        <div className="flex w-full min-h-[calc(100vh-64px)] items-center justify-center overflow-y-auto py-8">
            <Card className="w-full max-w-md">
                <CardHeader className="text-center">
                    <CardTitle className="text-2xl">
                        <span className="font-medium">eigen</span>
                        <span className="font-normal text-app">
                            <Bar />
                            signup
                            <Ket />
                        </span>
                    </CardTitle>
                    <CardDescription>
                        You've been invited as <strong>{invite.email}</strong>
                    </CardDescription>
                </CardHeader>

                <CardContent>
                    {error && (
                        <div className="p-3 mb-4 text-sm text-destructive bg-destructive/10 rounded-md">{error}</div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-6">
                        <FieldGroup>
                            <Field>
                                <FieldLabel htmlFor="name">Name</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="name"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        required
                                        autoFocus
                                    />
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
                                            <InputGroupText>@{invite.mailDomain}</InputGroupText>
                                        </InputGroupAddon>
                                    </InputGroup>
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
                                        minLength={8}
                                        required
                                    />
                                </FieldContent>
                            </Field>

                            <Field>
                                <FieldLabel htmlFor="confirmPassword">Confirm Password</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="confirmPassword"
                                        type="password"
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        minLength={8}
                                        required
                                    />
                                </FieldContent>
                            </Field>
                        </FieldGroup>

                        <Button type="submit" className="w-full" disabled={register.isPending}>
                            {register.isPending ? 'Creating account...' : 'Create Account'}
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}
