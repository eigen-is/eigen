// The registry of Eigen's apps: each app's name, color token, home URL, icon and one-line pitch.
// Every place that shows an app, such as the app switcher, the space index tiles and the help
// center, reads its color and icon from here, so an app looks the same everywhere. Admin stands
// apart from the list, because only an admin gets a way in.

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
    getVectorAppUrl,
} from '@workspace/lib/api';
import {
    Calendar,
    Diamond,
    FileText,
    HardDrive,
    LayoutDashboard,
    Mail,
    MessageSquare,
    Presentation,
    Sheet,
    Shield,
    SquareKanban,
    UsersRound,
} from 'lucide-react';

const apps = [
    {
        name: 'Space',
        color: 'var(--app-space-color)',
        href: getSpaceAppUrl(),
        icon: LayoutDashboard,
        description: 'Your workspace home',
    },
    {
        name: 'Mail',
        color: 'var(--app-mail-color)',
        href: getMailAppUrl(),
        icon: Mail,
        description: 'Check your inbox',
    },
    {
        name: 'Drive',
        color: 'var(--app-drive-color)',
        href: getDriveAppUrl(),
        icon: HardDrive,
        description: 'Browse your files',
    },
    {
        name: 'Calendar',
        color: 'var(--app-calendar-color)',
        href: getCalendarAppUrl(),
        icon: Calendar,
        description: 'Keep track of your schedule',
    },
    {
        name: 'Docs',
        color: 'var(--app-docs-color)',
        href: getDocsAppUrl(),
        icon: FileText,
        description: 'Write and edit documents',
    },
    {
        name: 'Sheets',
        color: 'var(--app-sheets-color)',
        href: getSheetsAppUrl(),
        icon: Sheet,
        description: 'Work with spreadsheets',
    },
    {
        name: 'Slides',
        color: 'var(--app-slides-color)',
        href: getSlidesAppUrl(),
        icon: Presentation,
        description: 'Create presentations',
    },
    {
        name: 'Vector',
        color: 'var(--app-vector-color)',
        href: getVectorAppUrl(),
        icon: Diamond,
        description: 'Draw and diagram',
    },
    {
        name: 'Stickies',
        color: 'var(--app-stickies-color)',
        href: getStickiesAppUrl(),
        icon: SquareKanban,
        description: 'Organize your tasks and ideas',
    },
    {
        name: 'Chat',
        color: 'var(--app-chat-color)',
        href: getChatAppUrl(),
        icon: MessageSquare,
        description: 'Chat with your team',
    },
    {
        name: 'Contacts',
        color: 'var(--app-contacts-color)',
        href: getContactsAppUrl(),
        icon: UsersRound,
        description: 'Find your contacts',
    },
];

type AppEntry = (typeof apps)[number];

const adminApp = {
    name: 'Admin',
    color: 'var(--app-admin-color)',
    href: getAdminAppUrl(),
    icon: Shield,
    description: 'Manage users, teams and the server',
} satisfies AppEntry;

// Hosted mail is optional on a server, so useEnabledApps and the palette's nav commands need one
// way to spot its entry.
const isMailApp = (app: AppEntry) => app.name === 'Mail';

export { adminApp, apps, isMailApp };
