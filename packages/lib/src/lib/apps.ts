const apps = [
    {
        name: 'Space',
        className: 'text-teal-600',
        href: import.meta.env.VITE_APP_SPACE_URL,
        icon: 'layout-dashboard',
    },
    {
        name: 'Mail',
        className: 'text-red-600',
        href: import.meta.env.VITE_APP_MAIL_URL,
        icon: 'mail',
    },
    // {
    //     name: 'Calendar',
    //     className: 'text-blue-600',
    //     href: import.meta.env.VITE_APP_CALENDAR_URL,
    //     icon: 'calendar',
    // },
    {
        name: 'Contacts',
        className: 'text-green-600',
        href: import.meta.env.VITE_APP_CONTACTS_URL,
        icon: 'users',
    },
    {
        name: 'Drive',
        className: 'text-yellow-600',
        href: import.meta.env.VITE_APP_DRIVE_URL,
        icon: 'hard-drive',
    },
    {
        name: 'Docs',
        className: 'text-purple-600',
        href: import.meta.env.VITE_APP_DOCS_URL,
        icon: 'file-text',
    },
];

export {apps};