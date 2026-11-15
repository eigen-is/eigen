// The apps the About pages describe: every app in the shared registry except Space, the workspace home, in the
// registry's order, then Admin for the person who runs the server. An app's slug is its name in lower case and names
// both its page's file and its URL, such as sheets.md and /about/sheets. Each app also says which of Eigen's three
// principles hold for it and how, such as CalDAV for Calendar, for the boxes beside its page and the tags under the
// landing page's blocks. The content build checks the About files against this list.

import { adminApp, apps } from '@workspace/lib/apps';

// The registry names its apps as plain strings, so the slugs are written out once here to give them a type; an app
// the registry adds without one throws below.
const aboutSlugs = [
    'mail',
    'drive',
    'calendar',
    'docs',
    'sheets',
    'slides',
    'vector',
    'stickies',
    'chat',
    'contacts',
    'admin',
] as const;

export type AboutSlug = (typeof aboutSlugs)[number];

export const principles = ['Use your favorite apps', 'Office compatible', 'Built for data sovereignty'] as const;

export type Principle = (typeof principles)[number];

// The short name a principle carries in a box beside an About page, where the full title wraps.
export const principleLabels: Record<Principle, string> = {
    'Use your favorite apps': 'Use your apps',
    'Office compatible': 'Office compatible',
    'Built for data sovereignty': 'Data sovereignty',
};

// Tags are file endings or protocols, such as `.xlsx` or `CalDAV`, and `article` a help article's slug, such as
// `sheets/import-excel`.
type AppPrinciple = { principle: Principle; line: string; tags: readonly string[]; article: string };

export const appPrinciples = {
    mail: [
        {
            principle: 'Use your favorite apps',
            line: 'Works with the mail app on your phone and computer.',
            tags: ['IMAP', 'SMTP'],
            article: 'connect/mail-client',
        },
        {
            principle: 'Built for data sovereignty',
            line: 'Every message is a plain .eml file.',
            tags: ['.eml'],
            article: 'mail/download-an-email',
        },
    ],
    drive: [
        {
            principle: 'Use your favorite apps',
            line: 'Open your files from Finder or Explorer.',
            tags: ['WebDAV'],
            article: 'connect/mount-drive-on-your-computer',
        },
    ],
    calendar: [
        {
            principle: 'Use your favorite apps',
            line: 'Syncs with the calendar on your phone.',
            tags: ['CalDAV'],
            article: 'connect/calendar-client',
        },
        {
            principle: 'Built for data sovereignty',
            line: 'Imports and exports .ics.',
            tags: ['.ics'],
            article: 'calendar/export-events',
        },
    ],
    docs: [
        {
            principle: 'Office compatible',
            line: 'Reads and writes .docx files.',
            tags: ['.docx'],
            article: 'docs/import-word',
        },
    ],
    sheets: [
        {
            principle: 'Office compatible',
            line: 'Reads and writes .xlsx files.',
            tags: ['.xlsx'],
            article: 'sheets/import-excel',
        },
    ],
    slides: [
        {
            principle: 'Office compatible',
            line: 'Reads and writes .pptx files.',
            tags: ['.pptx'],
            article: 'slides/import-powerpoint',
        },
    ],
    vector: [
        {
            principle: 'Built for data sovereignty',
            line: 'Exports .svg.',
            tags: ['.svg'],
            article: 'vector/export-drawing',
        },
    ],
    contacts: [
        {
            principle: 'Use your favorite apps',
            line: 'Syncs with the contacts on your phone.',
            tags: ['CardDAV'],
            article: 'connect/contacts-client',
        },
        {
            principle: 'Built for data sovereignty',
            line: 'Imports and exports .vcf.',
            tags: ['.vcf'],
            article: 'contacts/export-contacts',
        },
    ],
    admin: [
        {
            principle: 'Built for data sovereignty',
            line: 'Backups are plain .tar archives.',
            tags: ['.tar', '.tar.zst'],
            article: 'self-hosting/back-up-and-restore',
        },
    ],
} satisfies Partial<Record<AboutSlug, readonly AppPrinciple[]>>;

const principlesBySlug = new Map<string, readonly AppPrinciple[]>(Object.entries(appPrinciples));

export const aboutApps = [...apps.filter((app) => app.name !== 'Space'), adminApp].map((app) => {
    const slug = aboutSlugs.find((entry) => entry === app.name.toLowerCase());
    if (!slug) throw new Error(`${app.name} has no About slug`);
    return { ...app, slug, principles: principlesBySlug.get(slug) ?? [] };
});

export type AboutApp = (typeof aboutApps)[number];
