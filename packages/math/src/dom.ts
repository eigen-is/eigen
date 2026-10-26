// fromDom adapts a browser DOM element to MathXmlElement, the shape the MathML and OMML readers take, so a paste or
// a DOMParser result reads like the XML the API parses.

import type { MathXmlElement } from './xml';

// The DOM, structurally: the package has no DOM types.
type DomText = { nodeType: number; nodeValue: string | null };

type DomElement = DomText & {
    namespaceURI: string | null;
    localName: string;
    attributes: ArrayLike<{ name: string; value: string | null }>;
    childNodes: ArrayLike<DomElement | DomText>;
};

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

function isDomElement(node: DomElement | DomText): node is DomElement {
    return node.nodeType === ELEMENT_NODE;
}

// Children adapt once, on first read, so a reader's depth bound stops a deep DOM before the adapter recurses.
export function fromDom(element: DomElement): MathXmlElement {
    let children: (string | MathXmlElement)[] | undefined;
    return {
        ns: element.namespaceURI ?? '',
        local: element.localName,
        attributes: Object.fromEntries(Array.from(element.attributes, ({ name, value }) => [name, value ?? ''])),
        get children() {
            children ??= Array.from(element.childNodes).flatMap((node): (string | MathXmlElement)[] => {
                if (isDomElement(node)) return [fromDom(node)];
                return node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE
                    ? [node.nodeValue ?? '']
                    : [];
            });
            return children;
        },
    };
}
