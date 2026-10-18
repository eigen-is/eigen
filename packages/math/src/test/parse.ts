import { Window } from 'happy-dom';
import { fromDom } from '../dom';
import { readLatex, writeLatex } from '../latex';
import { readMathml, writeMathml } from '../mathml';
import { OMML_NAMESPACE, readOmml, WORDML_NAMESPACE, writeOmml } from '../omml';
import type { MathRow } from '../tree';
import { elementsOf, type MathXmlElement } from '../xml';

const window = new Window();

// The browser's route into the readers: DOMParser, then fromDom.
export function el(xml: string): MathXmlElement {
    const document = new window.DOMParser().parseFromString(xml, 'application/xml');
    if (document.getElementsByTagName('parsererror').length > 0) throw new Error(`Malformed XML: ${xml}`);
    return fromDom(document.documentElement);
}

// The paste route: an HTML DOM, which may leave math in the XHTML namespace, with a prefix in its name.
export function htmlMath(html: string): MathXmlElement {
    const elements = new window.DOMParser().parseFromString(html, 'text/html').body.querySelectorAll('*');
    const math = Array.from(elements).find((element) => /^(?:\w+:)?math$/.test(element.localName));
    if (!math) throw new Error(`No math in ${html}`);
    return fromDom(math);
}

// The writer leaves m: and w: to the caller, which binds them on its root.
export const parseWritten = (omml: string) =>
    elementsOf(el(`<root xmlns:m="${OMML_NAMESPACE}" xmlns:w="${WORDML_NAMESPACE}">${omml}</root>`))[0];

export const viaOmml = (row: MathRow) => readOmml(parseWritten(writeOmml(row)));
export const viaMathml = (row: MathRow) => readMathml(el(writeMathml(row)));
export const viaLatex = (row: MathRow) => readLatex(writeLatex(row));

export const letter = (text: string): MathRow => [{ kind: 'identifier', text }];
