// The public site's landing page: the cycling eigen|app⟩ wordmark, what Eigen is and the apps it has, the buttons the
// server's admin turned on, such as the waitlist form, and three things it stands for. A signed-in visitor goes
// straight on to the app.

import { createFileRoute } from '@tanstack/react-router';
import { getDemoEnterUrl, getSpaceAppUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { usePublicConfig } from '@workspace/lib/public';
import { EigenCyclingLogo } from '@workspace/ui/components/braket';
import { Button } from '@workspace/ui/components/button';
import { AppShell } from '@workspace/ui/components/layout/app';
import { useEffect, useState } from 'react';
import { LandingApps } from '../components/landing-apps';
import { LandingBlocks } from '../components/landing-blocks';
import { LandingLinks } from '../components/landing-links';
import { SitePage } from '../components/site-page';
import { WaitlistForm } from '../components/waitlist-form';

export const Route = createFileRoute('/')({
    component: HomeComponent,
});

function HomeComponent() {
    const [showWaitlistForm, setShowWaitlistForm] = useState(false);
    const { data: config } = usePublicConfig();
    const waitlistEnabled = config?.waitlistEnabled ?? false;
    const demoMode = config?.demoMode ?? false;
    const showInstall = config?.showInstall ?? false;
    const { isAuthenticated } = useAuth();

    // The page hydrates before the session check answers, so an effect that reacts to auth flipping sends a
    // signed-in visitor on; a one-shot router guard would only ever see the signed-out state.
    useEffect(() => {
        if (isAuthenticated) window.location.href = getSpaceAppUrl();
    }, [isAuthenticated]);

    // A demo server sends visitors into a seeded persona through its entry route, which mints the session.
    const handleLogin = () => {
        window.location.href = demoMode ? getDemoEnterUrl() : getSpaceAppUrl();
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
                                    <LandingApps />
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
                            <LandingLinks />
                        </div>
                    ) : (
                        <WaitlistForm onClose={() => setShowWaitlistForm(false)} />
                    )}
                </section>
                <LandingBlocks showInstall={showInstall} />
            </SitePage>
        </AppShell>
    );
}
