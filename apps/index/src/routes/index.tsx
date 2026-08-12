import { createFileRoute, Link } from '@tanstack/react-router';
import { getDemoEnterUrl, getSpaceAppUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useJoinWaitlist, usePublicConfig } from '@workspace/lib/public';
import { Button } from '@workspace/ui/components/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { EigenCyclingLogo } from '@workspace/ui/components/layout/braket';
import { Textarea } from '@workspace/ui/components/textarea';
import React, { useCallback } from 'react';

export const Route = createFileRoute('/')({
    component: HomeComponent,
});

export function HomeComponent() {
    const [showWaitlistForm, setShowWaitlistForm] = React.useState(false);
    const [email, setEmail] = React.useState('');
    const [notes, setNotes] = React.useState('');
    const { data: config } = usePublicConfig();
    const waitlistEnabled = config?.waitlistEnabled ?? false;
    const landingLinks = config?.landingLinks ?? [];
    const demoMode = config?.demoMode ?? false;
    const { isAuthenticated } = useAuth();
    const joinWaitlist = useJoinWaitlist();

    // This page is prerendered and hydrates before the session check resolves, so
    // send signed-in visitors to the app from an effect that reacts to auth flipping
    // — a one-shot router guard would only ever see the pre-auth (signed-out) state.
    React.useEffect(() => {
        if (isAuthenticated) window.location.href = getSpaceAppUrl();
    }, [isAuthenticated]);

    const resetForm = useCallback(() => {
        setShowWaitlistForm(false);
        setEmail('');
        setNotes('');
    }, []);

    const handleLogin = useCallback(() => {
        // Demo instances send visitors straight into a seeded persona via the entry route,
        // which mints the session and 302s to /space.
        window.location.href = demoMode ? getDemoEnterUrl() : '/space/';
    }, [demoMode]);

    const handleShowWaitlist = useCallback(() => {
        setShowWaitlistForm(true);
    }, []);

    const handleWaitlistSubmit = useCallback(
        (e: React.FormEvent) => {
            e.preventDefault();
            // On failure the hook toasts the reason and isPending clears, re-enabling the form so the
            // visitor can retry; only a success clears the fields and closes the card.
            joinWaitlist.mutate({ email, notes }, { onSuccess: resetForm });
        },
        [email, notes, joinWaitlist.mutate, resetForm],
    );

    return (
        <div className="flex flex-col items-center justify-center min-h-screen p-4">
            <EigenCyclingLogo className="text-5xl mb-8" />
            <div className="text-lg text-center mb-8 max-w-md">
                <div>
                    <p className="mb-4">
                        Your personal workspace in the cloud.
                        <br />
                        Simple and secure. You control your data.
                    </p>
                </div>
            </div>

            {!showWaitlistForm ? (
                <>
                    <div className="flex flex-wrap gap-4">
                        <Button className="px-8 py-2 font-medium flex-3" onClick={handleLogin}>
                            {demoMode ? 'Enter demo' : 'Login'}
                        </Button>
                        {waitlistEnabled && (
                            <Button variant="outline" className="px-6 py-2 flex-1" onClick={handleShowWaitlist}>
                                Join Waitlist
                            </Button>
                        )}
                        {landingLinks.map((link) => (
                            <Button
                                key={`${link.title}:${link.url}`}
                                variant="outline"
                                className="px-6 py-2 flex-3"
                                asChild
                            >
                                <a href={link.url} rel="noopener">
                                    {link.title}
                                </a>
                            </Button>
                        ))}
                    </div>
                    <div className="flex justify-center gap-4 mt-4 text-sm">
                        <Link to="/support" className="text-link hover:text-link/80 underline">
                            Learn more
                        </Link>
                        <Link to="/blog" className="text-link hover:text-link/80 underline">
                            Blog
                        </Link>
                        <Link to="/changelog" className="text-link hover:text-link/80 underline">
                            Changelog
                        </Link>
                        <a
                            href="https://github.com/eigen-is/eigen"
                            target="_blank"
                            rel="noreferrer"
                            className="text-link hover:text-link/80 underline inline-flex items-center gap-1.5"
                        >
                            GitHub
                        </a>
                    </div>
                </>
            ) : (
                <Card className="w-full max-w-md">
                    <CardHeader>
                        <CardTitle>
                            Join the Waitlist <small>(Exclusive Access Only)</small>
                        </CardTitle>
                    </CardHeader>
                    <form onSubmit={handleWaitlistSubmit}>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="email">Email</Label>
                                <Input
                                    id="email"
                                    type="email"
                                    placeholder="Enter your email"
                                    value={email}
                                    disabled={joinWaitlist.isPending}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="notes">Notes (Optional)</Label>
                                <Textarea
                                    id="notes"
                                    placeholder="Tell us why you're interested"
                                    value={notes}
                                    disabled={joinWaitlist.isPending}
                                    onChange={(e) => setNotes(e.target.value)}
                                />
                            </div>
                        </CardContent>
                        <CardFooter className="flex justify-end mt-4 gap-4">
                            <Button
                                type="button"
                                variant="outline"
                                disabled={joinWaitlist.isPending}
                                onClick={resetForm}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={joinWaitlist.isPending}>
                                {joinWaitlist.isPending ? 'Submitting...' : 'Submit'}
                            </Button>
                        </CardFooter>
                    </form>
                </Card>
            )}
        </div>
    );
}
