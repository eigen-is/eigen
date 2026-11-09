// The search shapes the API and the apps share: the sources one search request can cover, what it
// answers, and a hit from the help center's static index that the command palette also shows.

import type { DrivePath } from './drive';
import type { EmailSummary } from './mail';

export const SEARCH_SOURCES = ['mail', 'file'] as const;

export type SearchSource = (typeof SEARCH_SOURCES)[number];

export type SearchResponse = {
    mail: EmailSummary[];
    file: DrivePath[];
};

// `excerpt` is trusted build-time HTML with <mark> match highlights; `url` is an absolute /support path.
export type HelpSearchDoc = {
    url: string;
    excerpt: string;
    meta: { title?: string; section?: string };
};
