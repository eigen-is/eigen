import { Window } from 'happy-dom';
import { fromDom } from '../dom';
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

// The writer leaves m: and w: to the caller, as the docx writer binds them on its root.
export const parseWritten = (omml: string) =>
    elementsOf(el(`<root xmlns:m="${OMML_NAMESPACE}" xmlns:w="${WORDML_NAMESPACE}">${omml}</root>`))[0];

export const viaOmml = (row: MathRow) => readOmml(parseWritten(writeOmml(row)));
