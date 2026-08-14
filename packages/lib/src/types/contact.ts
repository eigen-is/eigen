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
    // sha256 of the card file's bytes; a write must echo the one it loaded so a stale form 412s (spec § 3).
    // Absent on a create payload and on emptyContact — the server assigns it.
    etag?: string;
};

// Projection produced by useContactSuggestions: the de-duped union of personal
// contacts + team members the autosuggest UIs (mail/calendar/chat/drive-share) and
// the command palette all consume. `kind` + `teamId` let the palette navigate
// team members to their team-scoped detail page (book/all doesn't index them).
export type ContactSuggestion = {
    kind: 'personal' | 'team';
    id: string;
    displayName: string;
    email: string;
    // Only set for kind: 'team' — the team the member was matched from.
    teamId?: string;
};
