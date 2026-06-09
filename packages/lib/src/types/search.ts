import type { DrivePath } from './drive';
import type { EmailSummary } from './mail';

export type SearchSource = 'mail' | 'file';

export type SearchResponse = {
    mail: EmailSummary[];
    file: DrivePath[];
};

// A help-center search hit from the index app's static Pagefind index. `excerpt` is
// trusted build-time HTML with <mark> match highlights; `url` is an absolute /support
// path. Shared by the command palette's help source and the index app's SupportSearch.
export type HelpSearchDoc = {
    url: string;
    excerpt: string;
    meta: { title?: string; section?: string };
};
