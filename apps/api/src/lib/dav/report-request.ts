import { type XmlElement, xmlChild, xmlChildren, xmlTrimmedText } from '../core/xml';
import { DAV_NAMESPACES } from './xml';

const DAV = DAV_NAMESPACES.D;

// A multiget's hrefs, trimmed: a client that indents its body indents inside the href too.
export function readHrefs(root: XmlElement): string[] {
    return xmlChildren(root, DAV, 'href').map(xmlTrimmedText);
}

// An absent or empty <D:sync-token/> asks for the initial sync.
export function readSyncToken(root: XmlElement): string | undefined {
    return xmlTrimmedText(xmlChild(root, DAV, 'sync-token')) || undefined;
}

// A filter the parser can't map, in CalDAV or CardDAV: answered 403 supported-filter, never with a superset.
export class UnsupportedFilterError extends Error {}
