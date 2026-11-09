// The top of the landing page: a headline whose word cycles through the apps, the one-line pitch and the lines that
// name what Eigen does. Each app in those lines links to its Support section, and pointing at one shows that app in
// the headline and holds the cycle. The first render is always "workspace" in the Space color and the timer starts
// in an effect, so the prerendered page and the first client render are the same.

import { Link } from '@tanstack/react-router';
import { apps } from '@workspace/lib/apps';
import { Bar, Ket } from '@workspace/ui';
import { Fragment, useEffect, useState } from 'react';

const CYCLE_MS = 2000;

function appNamed(name: string) {
    const app = apps.find((entry) => entry.name === name);
    if (!app) throw new Error(`The landing page references unknown app: ${name}`);
    return app;
}

const SPACE = appNamed('Space');

// The order the pitch line names the apps in, which is also the order the headline cycles through.
const HERO_APPS = [
    'Mail',
    'Drive',
    'Docs',
    'Sheets',
    'Slides',
    'Vector',
    'Stickies',
    'Calendar',
    'Contacts',
    'Chat',
].map(appNamed);

// Vector is called drawings in the pitch, and the line starts with a capital.
function wordFor(name: string, first: boolean): string {
    if (name === 'Vector') return 'drawings';
    return first ? name : name.toLowerCase();
}

type LandingHeroProps = {
    demoMode: boolean;
};

export function LandingHero({ demoMode }: LandingHeroProps) {
    const [shown, setShown] = useState<number | null>(null);
    const [paused, setPaused] = useState(false);

    useEffect(() => {
        if (paused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const timer = setInterval(() => setShown((n) => (n === null ? 0 : (n + 1) % HERO_APPS.length)), CYCLE_MS);
        return () => clearInterval(timer);
    }, [paused]);

    const app = shown === null ? SPACE : HERO_APPS[shown];
    const word = shown === null ? 'workspace' : app.name.toLowerCase();

    return (
        <>
            <h1 className="text-5xl leading-none tracking-normal">
                <span className="font-medium">your own</span>
                <span className="font-normal" style={{ color: app.color }}>
                    <Bar />
                    {word}
                    <Ket />
                </span>
            </h1>
            <p className="mt-8 text-lg leading-7">Eigen is a self-hosted alternative to Google Workspace.</p>
            <div className="mt-4 text-sm leading-5 text-balance text-muted-foreground">
                {demoMode ? (
                    <p>
                        Explore a shared workspace of a small fictional crew organizing the Tuimel Festival. It resets
                        every hour.
                    </p>
                ) : (
                    <>
                        <p>
                            {HERO_APPS.map((entry, index) => (
                                <Fragment key={entry.name}>
                                    {index > 0 && (index < HERO_APPS.length - 1 ? ', ' : ' and ')}
                                    <Link
                                        to="/support/$section"
                                        params={{ section: entry.name.toLowerCase() }}
                                        className="underline decoration-muted-foreground/45 decoration-1 underline-offset-2 transition-colors duration-150 hover:decoration-current"
                                        style={paused && shown === index ? { color: entry.color } : undefined}
                                        onMouseEnter={() => {
                                            setShown(index);
                                            setPaused(true);
                                        }}
                                        onMouseLeave={() => setPaused(false)}
                                    >
                                        {wordFor(entry.name, index === 0)}
                                    </Link>
                                </Fragment>
                            ))}
                            .
                        </p>
                        <p>Syncs with your own apps over IMAP, SMTP, CalDAV, CardDAV and WebDAV.</p>
                        <p>Opens and saves Word, Excel and PowerPoint files.</p>
                    </>
                )}
            </div>
        </>
    );
}
