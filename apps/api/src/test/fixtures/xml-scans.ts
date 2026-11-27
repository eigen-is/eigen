// Counts what our XML finders scan, for the import tests that bound how often a read looks through a shared part,
// such as a deck's master or a document's notes. Handed to countCalls, it weighs each finder's call by the children
// it scans, and a prefixed attribute's read by the attributes, so a lookup repeated per inheritor shows in the count.

import { spyOn } from 'bun:test';
import type { Count } from '@workspace/lib/test/count-calls';
import * as xml from '../../lib/core/xml';

export function countXmlScans(count: Count): void {
    count(spyOn(xml, 'xmlElements'), ([element]) => element.children.length);
    count(spyOn(xml, 'xmlChildren'), ([element]) => element.children.length);
    count(spyOn(xml, 'xmlChild'), ([element]) => element.children.length);
    count(spyOn(xml, 'xmlAttr'), ([element, ns]) => (ns === '' ? 0 : Object.keys(element.attributeNs).length));
}
