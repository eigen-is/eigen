import {
    getAdminAppUrl,
    getCalendarAppUrl,
    getChatAppUrl,
    getContactsAppUrl,
    getDocsAppUrl,
    getDriveAppUrl,
    getMailAppUrl,
    getSheetsAppUrl,
    getSlidesAppUrl,
    getSpaceAppUrl,
    getStickiesAppUrl,
} from '@workspace/lib/api';
import type { Command } from '@workspace/lib/types/command-palette';
import {
    Calendar as CalendarIcon,
    FileText,
    Folder,
    Home as HomeIcon,
    Mail,
    MessageSquare,
    Presentation,
    Settings,
    Shield,
    StickyNote,
    Table,
    Users,
} from 'lucide-react';

// Cross-app navigation: every `Go to <App>` lands at a separate origin. Each helper
// returns an absolute URL; the palette context's navigate() always uses
// `window.location.href = url`. The path inside the app (the part after `/`)
// matches that app's existing landing-page convention — verified once for each app
// before locking in.

export const navCommands: Command[] = [
    {
        id: 'nav.mail',
        title: 'Go to Mail',
        keywords: ['inbox', 'email'],
        icon: Mail,
        baseRank: 10,
        run: (ctx) => ctx.navigate(getMailAppUrl(`box/inbox`)),
    },
    {
        id: 'nav.drive',
        title: 'Go to Drive',
        keywords: ['files', 'folders'],
        icon: Folder,
        baseRank: 10,
        run: (ctx) => ctx.navigate(getDriveAppUrl(`${ctx.ownerId}`)),
    },
    {
        id: 'nav.calendar',
        title: 'Go to Calendar',
        keywords: ['events', 'schedule'],
        icon: CalendarIcon,
        baseRank: 10,
        run: (ctx) => ctx.navigate(getCalendarAppUrl(`${ctx.ownerId}`)),
    },
    {
        id: 'nav.contacts',
        title: 'Go to Contacts',
        keywords: ['people', 'address book'],
        icon: Users,
        baseRank: 10,
        run: (ctx) => ctx.navigate(getContactsAppUrl(`${ctx.ownerId}`)),
    },
    {
        id: 'nav.docs',
        title: 'Go to Docs',
        keywords: ['documents'],
        icon: FileText,
        baseRank: 8,
        run: (ctx) => ctx.navigate(getDocsAppUrl(`${ctx.ownerId}`)),
    },
    {
        id: 'nav.sheets',
        title: 'Go to Sheets',
        keywords: ['spreadsheets'],
        icon: Table,
        baseRank: 8,
        run: (ctx) => ctx.navigate(getSheetsAppUrl(`${ctx.ownerId}`)),
    },
    {
        id: 'nav.slides',
        title: 'Go to Slides',
        keywords: ['presentations'],
        icon: Presentation,
        baseRank: 8,
        run: (ctx) => ctx.navigate(getSlidesAppUrl(`${ctx.ownerId}`)),
    },
    {
        id: 'nav.stickies',
        title: 'Go to Stickies',
        keywords: ['kanban', 'cards'],
        icon: StickyNote,
        baseRank: 8,
        run: (ctx) => ctx.navigate(getStickiesAppUrl(`${ctx.ownerId}`)),
    },
    {
        id: 'nav.chat',
        title: 'Go to Chat',
        keywords: ['messages'],
        icon: MessageSquare,
        baseRank: 8,
        run: (ctx) => ctx.navigate(getChatAppUrl(`${ctx.ownerId}`)),
    },
    {
        id: 'nav.space',
        title: 'Go to Space',
        keywords: ['workspace'],
        icon: HomeIcon,
        baseRank: 8,
        run: (ctx) => ctx.navigate(getSpaceAppUrl()),
    },
    {
        id: 'nav.admin',
        title: 'Go to Admin',
        keywords: ['organisation', 'organization'],
        icon: Shield,
        baseRank: 5,
        run: (ctx) => ctx.navigate(getAdminAppUrl()),
    },
    {
        id: 'nav.settings',
        title: 'Go to Settings',
        keywords: ['preferences', 'account'],
        icon: Settings,
        baseRank: 5,
        run: (ctx) => ctx.navigate(getSpaceAppUrl('user')),
    },
];
