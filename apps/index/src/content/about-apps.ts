// The apps the About pages describe: every app in the shared registry except Space, the workspace home, in the
// registry's order. An app's slug is its name in lower case and names both its page's file and its URL, such as
// sheets.md and /about/sheets. Each also says what it opens and saves and which protocols other apps reach it by,
// for the panel on its page and the tags under the landing page's blocks. The content build checks the About files
// against this list, and the pages list the apps in its order.

import { apps } from '@workspace/lib/apps';

// File types as their endings, such as `.xlsx`, and `article` as a help article's slug, such as `sheets/import-excel`.
export type AppFormats = { files: readonly string[]; protocols: readonly string[]; text: string; article: string };

export const appFormats = {
    mail: {
        files: ['.eml'],
        protocols: ['IMAP', 'SMTP'],
        text: 'Read and send from the mail app you already use. Any message downloads as an .eml file, and an .eml file from another mail program imports.',
        article: 'connect/mail-client',
    },
    drive: {
        files: [],
        protocols: ['WebDAV'],
        text: 'Mount Drive as a folder on your computer, and your files open and copy like any other.',
        article: 'connect/mount-drive-on-your-computer',
    },
    calendar: {
        files: ['.ics'],
        protocols: ['CalDAV'],
        text: 'Your calendars sync with the calendar app on your phone or computer, and import and export as .ics files.',
        article: 'connect/calendar-client',
    },
    docs: {
        files: ['.docx'],
        protocols: [],
        text: 'Bring your Word files in, and download any document as Word again, or as PDF.',
        article: 'docs/import-word',
    },
    sheets: {
        files: ['.xlsx'],
        protocols: [],
        text: 'Bring your Excel files in, and download any spreadsheet as Excel again, or as PDF.',
        article: 'sheets/import-excel',
    },
    slides: {
        files: ['.pptx'],
        protocols: [],
        text: 'Bring your PowerPoint files in, and download any deck as PowerPoint again, or as PDF.',
        article: 'slides/import-powerpoint',
    },
    vector: {
        files: ['.svg'],
        protocols: [],
        text: 'Download any drawing as an SVG image or a PDF.',
        article: 'vector/export-drawing',
    },
    contacts: {
        files: ['.vcf'],
        protocols: ['CardDAV'],
        text: 'Your address book syncs with the contacts app on your phone or computer, and imports and exports as .vcf files.',
        article: 'connect/contacts-client',
    },
} satisfies Record<string, AppFormats>;

const formatsBySlug = new Map<string, AppFormats>(Object.entries(appFormats));

export const aboutApps = apps
    .filter((app) => app.name !== 'Space')
    .map((app) => {
        const slug = app.name.toLowerCase();
        return { ...app, slug, formats: formatsBySlug.get(slug) };
    });

export type AboutApp = (typeof aboutApps)[number];
