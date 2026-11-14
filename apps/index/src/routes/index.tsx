// The public site's landing page: the cycling eigen|app⟩ wordmark, what Eigen is and the apps it has, the buttons the
// server's admin turned on, such as the waitlist form, and three things it stands for. A signed-in visitor goes
// straight on to the app.

import { createFileRoute } from '@tanstack/react-router';
import { getDemoEnterUrl, getSpaceAppUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useJoinWaitlist, usePublicConfig } from '@workspace/lib/public';
import { EigenCyclingLogo } from '@workspace/ui/components/braket';
import { Button } from '@workspace/ui/components/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { AppShell } from '@workspace/ui/components/layout/app';
import { Textarea } from '@workspace/ui/components/textarea';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { LandingBlocks } from '../components/landing-blocks';
import { SitePage } from '../components/site-page';

export const Route = createFileRoute('/')({
    component: HomeComponent,
});

function HomeComponent() {
    const [showWaitlistForm, setShowWaitlistForm] = useState(false);
    const [email, setEmail] = useState('');
    const [notes, setNotes] = useState('');
    const { data: config } = usePublicConfig();
    const waitlistEnabled = config?.waitlistEnabled ?? false;
    const landingLinks = config?.landingLinks ?? [];
    const demoMode = config?.demoMode ?? false;
    const showInstall = config?.showInstall ?? false;
    const { isAuthenticated } = useAuth();
    const joinWaitlist = useJoinWaitlist();

    // The page hydrates before the session check answers, so an effect that reacts to auth flipping sends a
    // signed-in visitor on; a one-shot router guard would only ever see the signed-out state.
    useEffect(() => {
        if (isAuthenticated) window.location.href = getSpaceAppUrl();
    }, [isAuthenticated]);

    const resetForm = () => {
        setShowWaitlistForm(false);
        setEmail('');
        setNotes('');
    };

    // A demo server sends visitors into a seeded persona through its entry route, which mints the session.
    const handleLogin = () => {
        window.location.href = demoMode ? getDemoEnterUrl() : getSpaceAppUrl();
    };

    const handleWaitlistSubmit = (e: FormEvent) => {
        e.preventDefault();
        // On failure the hook toasts the reason and the form re-enables for a retry; a success clears and closes it.
        joinWaitlist.mutate({ email, notes }, { onSuccess: resetForm });
    };

    return (
        <AppShell appName="" rootRoute={Route}>
            <SitePage>
                <section className="flex flex-1 flex-col items-center justify-center app-gutter-x py-16 text-center">
                    <EigenCyclingLogo className="text-5xl mb-8" />
                    <div className="text-lg mb-8 max-w-xl">
                        <h1 className="mb-4">A self-hosted alternative to Google Workspace.</h1>
                        <div className="text-sm text-muted-foreground text-balance">
                            {demoMode ? (
                                <p>
                                    Look around the workspace of a fictional crew organizing the Tuimel Festival. Change
                                    anything you like: it resets every hour.
                                </p>
                            ) : (
                                <>
                                    <p>
                                        Mail, drive, docs, sheets, slides, drawings, stickies, calendar, contacts and
                                        chat.
                                    </p>
                                    <p>Works with the apps already on your phone and computer.</p>
                                    <p>Runs on your own server, with your files in open formats.</p>
                                </>
                            )}
                        </div>
                    </div>
                    {!showWaitlistForm ? (
                        <div className="flex flex-wrap justify-center gap-4">
                            <Button className="px-8 py-2 font-medium flex-3" onClick={handleLogin}>
                                {demoMode ? 'Enter demo' : 'Log in'}
                            </Button>
                            {waitlistEnabled && (
                                <Button
                                    variant="outline"
                                    className="px-6 py-2 flex-1"
                                    onClick={() => setShowWaitlistForm(true)}
                                >
                                    Join waitlist
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
                    ) : (
                        <Card className="w-full max-w-md text-left">
                            <CardHeader>
                                <CardTitle>Join the waitlist</CardTitle>
                            </CardHeader>
                            <form onSubmit={handleWaitlistSubmit}>
                                <CardContent className="space-y-4">
                                    <div className="space-y-2">
                                        <Label htmlFor="email">Email</Label>
                                        <Input
                                            id="email"
                                            type="email"
                                            placeholder="you@example.com"
                                            value={email}
                                            disabled={joinWaitlist.isPending}
                                            onChange={(e) => setEmail(e.target.value)}
                                            required
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="notes">Notes (optional)</Label>
                                        <Textarea
                                            id="notes"
                                            placeholder="What would you use Eigen for?"
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
                                        {joinWaitlist.isPending ? 'Joining…' : 'Join waitlist'}
                                    </Button>
                                </CardFooter>
                            </form>
                        </Card>
                    )}
                </section>
                <LandingBlocks showInstall={showInstall} />
            </SitePage>
        </AppShell>
    );
}
