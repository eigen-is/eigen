// The landing page's line that names the apps, such as "Mail, drive, docs". A word links to its app's About page
// once that page is written, so the line reads the same on every server and gains links as the pages land. It is
// plain markup, so the prerender has every link.

import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';
import type { AboutSlug } from '../content/about-apps';
import { getAboutArticles } from '../content/manifest';

// The line's words in its order, each with the About slug of the app it names: Vector is "drawings" here.
const WORDS: readonly { word: string; slug: AboutSlug }[] = [
    { word: 'Mail', slug: 'mail' },
    { word: 'drive', slug: 'drive' },
    { word: 'docs', slug: 'docs' },
    { word: 'sheets', slug: 'sheets' },
    { word: 'slides', slug: 'slides' },
    { word: 'drawings', slug: 'vector' },
    { word: 'stickies', slug: 'stickies' },
    { word: 'calendar', slug: 'calendar' },
    { word: 'contacts', slug: 'contacts' },
    { word: 'chat', slug: 'chat' },
];

export function LandingApps() {
    const written = new Set(getAboutArticles().map((page) => page.slug));
    return (
        <p>
            {WORDS.map(({ word, slug }, index) => (
                <Fragment key={slug}>
                    {index > 0 && (index === WORDS.length - 1 ? ' and ' : ', ')}
                    {written.has(slug) ? (
                        <Link to="/about/$app" params={{ app: slug }} className="underline hover:text-foreground">
                            {word}
                        </Link>
                    ) : (
                        word
                    )}
                </Fragment>
            ))}
            .
        </p>
    );
}
