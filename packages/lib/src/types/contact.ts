export type Address = {
    street?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
};

export type Contact = {
    id: string;
    firstName: string;
    lastName: string;
    email: string[];
    phone: string[];
    company?: string;
    jobTitle?: string;
    address?: Address[];
    birthday?: string;
    notes?: string;
    avatar?: string;
    labels?: string[];
    eigenId?: string;
};

// Projection produced by useContactSuggestions: the de-duped union of personal
// contacts + team members the autosuggest UIs (mail/calendar/chat/drive-share) and
// the command palette all consume. `kind` lets callers branch (e.g., palette opens
// the contacts app for personal entries and compose for team members, which don't
// have a personal contact id).
export type ContactSuggestion = {
    kind: 'personal' | 'team';
    id: string;
    displayName: string;
    email: string;
    allEmails: string[];
};
