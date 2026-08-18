// RFC 3986 § 2.2 pchar: sub-delims + ':'/'@' are legal raw in a path segment, and a reserved char's raw and %-encoded forms are NOT the same URI — so a client that PUT a raw '@' href must see '@' (never %40) in our listings, or it treats the two as different resources. encodeURIComponent over-encodes this set; un-escape it back (the sabre encodePath approach).
export function encodePathSegment(segment: string): string {
    return encodeURIComponent(segment).replace(/%(21|24|26|27|28|29|2A|2B|2C|3A|3B|3D|40)/g, decodeURIComponent);
}
