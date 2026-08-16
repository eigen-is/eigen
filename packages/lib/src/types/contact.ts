export type Address = {
    street?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
};

// The fields a card owns and a client may write — the POST body. The server assigns everything else: it
// mints the id and computes the etag from the card file's bytes.
export type CreateContactInput = {
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

// A stored contact as every read serves it: the server-assigned id and the etag of the card it was read from.
export type Contact = CreateContactInput & {
    id: string;
    // sha256 of the card file's bytes.
    etag: string;
};

// The PUT body: a write must echo the etag it loaded so a stale form 412s instead of clobbering a card that
// changed meanwhile (spec § 3). The id travels in the path, not the body.
export type UpdateContactInput = CreateContactInput & {
    etag: string;
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
