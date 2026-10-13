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

// Children adapt when a reader asks for them, so a reader's depth bound stops a deep DOM before the adapter recurses.
export function fromDom(element: DomElement): MathXmlElement {
    return {
        ns: element.namespaceURI ?? '',
        local: element.localName,
        attributes: Object.fromEntries(Array.from(element.attributes, ({ name, value }) => [name, value ?? ''])),
        get children() {
            const children: (string | MathXmlElement)[] = [];
            for (const node of Array.from(element.childNodes)) {
                if (isDomElement(node)) children.push(fromDom(node));
                else if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE)
                    children.push(node.nodeValue ?? '');
            }
            return children;
        },
    };
}
