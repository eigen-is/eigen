// A production build's app URLs: relative, so one bundle serves any hostname. configure writes them for the API, which
// prefixes API_URL when it builds links in mail.
export const APP_URLS = {
    VITE_API_HOST: '/eigen',
    VITE_APP_SPACE_URL: '/space',
    VITE_APP_MAIL_URL: '/mail',
    VITE_APP_CALENDAR_URL: '/calendar',
    VITE_APP_CONTACTS_URL: '/contacts',
    VITE_APP_DRIVE_URL: '/drive',
    VITE_APP_DOCS_URL: '/docs',
    VITE_APP_STICKIES_URL: '/stickies',
    VITE_APP_CHAT_URL: '/chat',
    VITE_APP_ADMIN_URL: '/admin',
    VITE_APP_SLIDES_URL: '/slides',
    VITE_APP_SHEETS_URL: '/sheets',
    VITE_APP_VECTOR_URL: '/vector',
    VITE_APP_INDEX_URL: '/',
};
