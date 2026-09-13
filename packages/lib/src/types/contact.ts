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

// One parsed vCard content line (RFC 2426 / RFC 6350 §3) as @workspace/lib/vcard produces it.
export type VCardLine = {
    group: string | null; // 'item1' for 'item1.EMAIL;…', else null
    name: string; // property name, UPPERCASED ('EMAIL')
    params: [string, string][]; // parameter name (UPPERCASED) / raw value, original order, quotes stripped
    value: string; // raw property value, unfolded, NOT unescaped
    raw: string | null; // exact source slice incl. original folding/CRLFs; null for built lines
};

export type ParsedCardPhoto =
    | { kind: 'inline'; bytes: Uint8Array; mediaType: string | null }
    | { kind: 'uri'; uri: string };

// The projection parseVCard maps a card down to: the properties Eigen owns, plus the untouched AST in
// `lines` so a write can merge edits back without disturbing properties we don't understand.
export type ParsedCard = {
    lines: VCardLine[];
    version: string | null;
    uid: string | null;
    firstName: string;
    lastName: string;
    email: string[];
    phone: string[];
    company: string;
    jobTitle: string;
    address: Address[];
    birthday: string; // normalized YYYY-MM-DD, or '' if absent/unparseable
    notes: string;
    categories: string[]; // unescaped names, comma-split
    eigenId: string | null; // X-EIGEN-ID value, verbatim
    isGroup: boolean; // KIND:group or X-ADDRESSBOOKSERVER-KIND:group
    photo: ParsedCardPhoto | null;
};

// What one vCard import file did: a card is imported, skipped as a duplicate (UID or first email) or as a
// group, or failed on its own content. The three always sum to the number of cards in the file.
export type ImportContactsResult = { imported: number; skipped: number; failed: number };
