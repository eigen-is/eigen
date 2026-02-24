const apps = [
    {
        name: 'Space',
        className: 'text-teal-600',
        href: import.meta.env.VITE_APP_SPACE_URL,
        icon: 'layout-dashboard',
        description: 'Your personal workspace in the cloud',
    },
    {
        name: 'Mail',
        className: 'text-red-600',
        href: import.meta.env.VITE_APP_MAIL_URL,
        icon: 'mail',
        description: 'Check your inbox',
    },
    {
        name: 'Contacts',
        className: 'text-sky-600',
        href: import.meta.env.VITE_APP_CONTACTS_URL,
        icon: 'users',
        description: 'Find your contacts',
    },
    {
        name: 'Drive',
        className: 'text-yellow-600',
        href: import.meta.env.VITE_APP_DRIVE_URL,
        icon: 'hard-drive',
        description: 'Browse your files',
    },
    {
        name: 'Docs',
        className: 'text-purple-600',
        href: import.meta.env.VITE_APP_DOCS_URL,
        icon: 'file-text',
        description: 'Open your documents',
    },
    {
        name: 'Stickies',
        className: 'text-emerald-600',
        href: import.meta.env.VITE_APP_STICKIES_URL,
        icon: 'sticky-note',
        description: 'Map out your ideas',
    },
    {
        name: 'Chat',
        className: 'text-orange-600',
        href: import.meta.env.VITE_APP_CHAT_URL,
        icon: 'message-square',
        description: 'Chat with your team',
    },
    // {
    //     name: 'Calendar',
    //     className: 'text-blue-600',
    //     href: import.meta.env.VITE_APP_CALENDAR_URL,
    //     icon: 'calendar',
    // },
];

export {apps};