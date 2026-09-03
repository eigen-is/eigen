/// <reference types="vite/client" />

// The VITE_* variables the shared client reads; every app URL is optional (see api.ts), so an
// unset one degrades to a same-origin relative link instead of breaking an update.
interface ImportMetaEnv {
    readonly VITE_API_HOST?: string;
    readonly VITE_APP_SPACE_URL?: string;
    readonly VITE_APP_MAIL_URL?: string;
    readonly VITE_APP_CONTACTS_URL?: string;
    readonly VITE_APP_DRIVE_URL?: string;
    readonly VITE_APP_DOCS_URL?: string;
    readonly VITE_APP_STICKIES_URL?: string;
    readonly VITE_APP_CHAT_URL?: string;
    readonly VITE_APP_SLIDES_URL?: string;
    readonly VITE_APP_SHEETS_URL?: string;
    readonly VITE_APP_VECTOR_URL?: string;
    readonly VITE_APP_CALENDAR_URL?: string;
    readonly VITE_APP_ADMIN_URL?: string;
    readonly VITE_APP_INDEX_URL?: string;
}
