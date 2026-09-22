import type { Address } from '@workspace/lib/types/contact';

// One parsed vCard content line (RFC 2426 / RFC 6350 §3) as this parser produces it.
export type VCardLine = {
    group: string | null; // 'item1' for 'item1.EMAIL;…', else null
    name: string; // property name, UPPERCASED ('EMAIL')
    params: [string, string][]; // parameter name (UPPERCASED) / raw value, original order, quotes stripped
    value: string; // raw property value, unfolded, NOT unescaped
    raw: string | null; // exact source slice incl. original folding/CRLFs; null for built lines
};

// The Eigen-owned edits a write merges back into a stored card. An absent key keeps the stored property.
export type CardEdits = Partial<{
    firstName: string;
    lastName: string;
    email: string[];
    phone: string[];
    address: Address[];
    company: string;
    jobTitle: string;
    birthday: string;
    notes: string;
    categories: string[];
    eigenId: string | null; // null = remove X-EIGEN-ID
    photo: { bytes: Uint8Array; mediaType: string } | null; // null = remove PHOTO; absent key = keep
}>;

export type ParsedCardPhoto =
    | { kind: 'inline'; bytes: Uint8Array; mediaType: string | null }
    | { kind: 'uri'; uri: string };

// The untouched AST rides along in `lines`, so a write merges edits back without disturbing unknown properties.
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
