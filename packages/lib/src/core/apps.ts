import {
    getChatAppUrl,
    getContactsAppUrl,
    getDocsAppUrl,
    getDriveAppUrl,
    getMailAppUrl,
    getSheetsAppUrl,
    getSlidesAppUrl,
    getSpaceAppUrl,
    getStickiesAppUrl,
} from "@workspace/lib/api";

const apps = [
    {
        name: 'Space',
        className: 'text-teal-600',
        href: getSpaceAppUrl(),
        icon: 'layout-dashboard',
        description: 'Your personal workspace in the cloud',
    },
    {
        name: 'Calendar',
        className: 'text-blue-600',
        href: import.meta.env.VITE_APP_CALENDAR_URL,
        icon: 'calendar',
    },
    {
        name: 'Chat',
        className: 'text-orange-600',
        href: getChatAppUrl(),
        icon: 'message-square',
        description: 'Chat with your team',
    },
    {
        name: 'Contacts',
        className: 'text-sky-600',
        href: getContactsAppUrl(),
        icon: 'users',
        description: 'Find your contacts',
    },
    {
        name: 'Drive',
        className: 'text-yellow-600',
        href: getDriveAppUrl(),
        icon: 'hard-drive',
        description: 'Browse your files',
    },
    {
        name: 'Docs',
        className: 'text-purple-600',
        href: getDocsAppUrl(),
        icon: 'file-text',
        description: 'Open your documents',
    },
    {
        name: 'Mail',
        className: 'text-red-600',
        href: getMailAppUrl(),
        icon: 'mail',
        description: 'Check your inbox',
    },
    {
        name: 'Sheets',
        className: 'text-lime-600',
        href: getSheetsAppUrl(),
        icon: 'sheet',
        description: 'Work with spreadsheets',
    },
    {
        name: 'Slides',
        className: 'text-pink-600',
        href: getSlidesAppUrl(),
        icon: 'presentation',
        description: 'Create presentations',
    },
    {
        name: 'Stickies',
        className: 'text-emerald-600',
        href: getStickiesAppUrl(),
        icon: 'sticky-note',
        description: 'Map out your ideas',
    },
    // {
    //     name: 'People',
    //     className: 'text-indigo-600',
    //     href: getPeopleAppUrl(),
    //     icon: 'users-round',
    //     description: 'Manage your organization',
    // },
];

export {apps};