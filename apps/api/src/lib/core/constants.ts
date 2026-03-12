export const PATHS = {
    DRIVE: {
        ROOT: 'mounts',
        DEFAULT_MOUNT: 'default',
        SHARED_DB: 'mounts/shared.db',
        METADATA_DB: 'metadata.db',
        DATA_DIR: 'data',
        THUMBS_DIR: 'thumbs',
        TMP_DIR: 'tmp',
        DOCS_DIR: 'docs'
    },
    MAIL: {
        ROOT: 'eigen.mail',
        MAILDIR: 'Maildir',
        DB: 'eigen.mail/mail.db',
        CUR: 'cur',
        NEW: 'new',
        TMP: 'tmp',
        ATTRIBUTES_FILE: '.attributes'
    },
    CONTACTS: {
        ROOT: 'eigen.contacts',
        DB: 'eigen.contacts/contacts.db',
        AVATARS: 'avatars'
    },
    CALENDAR: {
        ROOT: 'eigen.calendar',
        DB: 'eigen.calendar/calendar.db'
    }
} as const;

export const STANDARD_MAILBOXES = ['', 'Sent', 'Drafts', 'Trash', 'Spam', 'Archive'] as const;

export const DEFAULT_LABELS = [
    {name: 'Family', color: '#f87171'},
    {name: 'Friends', color: '#60a5fa'},
    {name: 'Work', color: '#4ade80'},
    {name: 'Important', color: '#facc15'}
] as const;
