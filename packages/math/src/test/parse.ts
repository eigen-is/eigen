import { Window } from 'happy-dom';
import { fromDom } from '../dom';
import type { MathXmlElement } from '../xml';

const window = new Window();

// The browser's route into the readers: DOMParser, then fromDom.
export function el(xml: string): MathXmlElement {
    const document = new window.DOMParser().parseFromString(xml, 'application/xml');
    if (document.getElementsByTagName('parsererror').length > 0) throw new Error(`Malformed XML: ${xml}`);
    return fromDom(document.documentElement);
}
