// The sign-up page a person reaches from an invite link. It checks the invite's token, then shows the form that
// creates their account, or why the link can't be used.

import { createFileRoute } from '@tanstack/react-router';
import { useValidateInviteToken } from '@workspace/lib/auth';
import { Bar, Ket } from '@workspace/ui/components/braket';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { ErrorState, LoadingState } from '@workspace/ui/components/layout/app';
import { z } from 'zod';
import { SignupForm } from '../components/space/signup-form';

export const Route = createFileRoute('/signup')({
    component: SignupPage,
    validateSearch: z.object({
        token: z.string().optional().catch(undefined),
    }),
});

function SignupPage() {
    const { token } = Route.useSearch();
    const { data: invite, isLoading, isError } = useValidateInviteToken(token);

    if (!token) return <ErrorState message="No invite token provided" />;
    if (isLoading) return <LoadingState />;
    if (isError || !invite?.valid) {
        return <ErrorState message="This invite link is invalid or has expired" />;
    }

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
                    <SignupForm token={token} mailDomain={invite.mailDomain} />
                </CardContent>
            </Card>
        </div>
    );
}
