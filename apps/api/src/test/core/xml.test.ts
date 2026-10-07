import { describe, expect, test } from 'bun:test';
import {
    ApiError,
    parseXml,
    serializeXmlChildren,
    type XmlElement,
    XmlError,
    xmlAttr,
    xmlChild,
    xmlChildren,
    xmlElements,
    xmlText,
} from '../../lib/core';

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const BOM = String.fromCharCode(0xfeff);

function utf16(text: string, order: 'le' | 'be', bom: boolean): Uint8Array {
    const offset = bom ? 2 : 0;
    const bytes = new Uint8Array(offset + text.length * 2);
    if (bom) bytes.set(order === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]);
    for (let i = 0; i < text.length; i++) {
        const [lo, hi] = [text.charCodeAt(i) & 0xff, text.charCodeAt(i) >> 8];
        bytes.set(order === 'le' ? [lo, hi] : [hi, lo], offset + i * 2);
    }
    return bytes;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const withUtf8Bom = (text: string): Uint8Array => new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(text)]);

function parsed(input: string | Uint8Array): XmlElement {
    const root = parseXml(input);
    if (!root) throw new Error('expected a root element');
    return root;
}

function expectXmlError(input: string | Uint8Array): XmlError {
    try {
        parseXml(input);
    } catch (error) {
        expect(error).toBeInstanceOf(XmlError);
        expect(error).toBeInstanceOf(ApiError);
        if (error instanceof XmlError) {
            expect(error.status).toBe(400);
            return error;
        }
    }
    throw new Error('expected an XmlError');
}

// Bun applies ATTLIST defaults to every element without a cap: this body is the shape of the amplification
// (each `<a/>` gains the default), kept small so a broken sniff fails on the result instead of on the clock.
const ATTLIST_BODY = `<!DOCTYPE r [<!ATTLIST a x CDATA "${'A'.repeat(1000)}">]><r>${'<a/>'.repeat(1000)}</r>`;
// The same declaration can inject a namespace binding the body never wrote.
const XMLNS_INJECTION =
    '<!DOCTYPE D:propfind [<!ATTLIST D:prop xmlns:D CDATA "urn:evil">]><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>';

describe('parseXml input', () => {
    test('reads a string and UTF-8 bytes alike', () => {
        for (const input of ['<a>é</a>', utf8('<a>é</a>')]) {
            expect(xmlText(parsed(input))).toBe('é');
        }
    });

    test('decodes UTF-16 LE and BE bytes, with a BOM or with a declared encoding', () => {
        for (const order of ['le', 'be'] as const) {
            expect(xmlText(parsed(utf16('<a>ü€</a>', order, true)))).toBe('ü€');
            const declared = '<?xml version="1.0" encoding="UTF-16"?><a>ü€</a>';
            expect(xmlText(parsed(utf16(declared, order, false)))).toBe('ü€');
        }
    });

    test('decodes declared ISO-8859-1 bytes', () => {
        const bytes = new Uint8Array([
            ...utf8('<?xml version="1.0" encoding="ISO-8859-1"?><a>'),
            0xe9,
            ...utf8('</a>'),
        ]);
        expect(xmlText(parsed(bytes))).toBe('é');
    });

    test('a BOM before the root is not content', () => {
        expect(parsed(`${BOM}<a/>`).name).toBe('a');
        expect(parsed(withUtf8Bom('<?xml version="1.0"?>\n<a/>')).name).toBe('a');
    });
});

describe('parseXml blank input', () => {
    test('empty, whitespace only and a lone BOM are null, as a string', () => {
        for (const input of ['', ' \n\t\r ', BOM, `${BOM} \n`]) {
            expect(parseXml(input)).toBeNull();
        }
    });

    test('empty, whitespace only and a lone BOM are null, as bytes', () => {
        const inputs = [
            new Uint8Array(),
            utf8(' \r\n\t'),
            withUtf8Bom(''),
            withUtf8Bom('\n'),
            utf16('', 'le', true),
            utf16('', 'be', true),
            utf16(' \n', 'le', true),
            utf16(' \n', 'be', true),
        ];
        for (const input of inputs) expect(parseXml(input)).toBeNull();
    });

    test('a prolog without a root is an error, not blank', () => {
        expectXmlError('<?xml version="1.0"?>');
        expectXmlError('<!-- nothing -->');
    });
});

describe('parseXml refuses a DOCTYPE', () => {
    test('the ATTLIST amplification and the namespace injection', () => {
        expectXmlError(ATTLIST_BODY);
        expectXmlError(utf8(ATTLIST_BODY));
        expectXmlError(XMLNS_INJECTION);
    });

    test('after a BOM, the XML declaration, whitespace, comments and PIs', () => {
        const prolog = '<?xml version="1.0"?>\n<!-- c --> <?pi data?>\r\n';
        expectXmlError(`${BOM}${ATTLIST_BODY}`);
        expectXmlError(withUtf8Bom(ATTLIST_BODY));
        expectXmlError(`${prolog}${ATTLIST_BODY}`);
        expectXmlError(utf8(`${prolog}${ATTLIST_BODY}`));
        expectXmlError(withUtf8Bom(`${prolog}${ATTLIST_BODY}`));
        // `<!-->` opens a comment that runs to the next `-->`, so the `<a/>` is comment text, not the root.
        expectXmlError(`<!--><a/>-->${ATTLIST_BODY}`);
    });

    test('behind a prolog longer than one read of it, and split across two', () => {
        for (let pad = 4080; pad < 4100; pad++) {
            expectXmlError(utf8(`<!--${'x'.repeat(pad)}-->${ATTLIST_BODY}`));
            expectXmlError(utf16(`<!--${'x'.repeat(pad)}-->${ATTLIST_BODY}`, 'le', true));
        }
        expectXmlError(utf8(`<!--${'x'.repeat(100_000)}-->${ATTLIST_BODY}`));
    });

    test('in UTF-16 LE and BE, with and without a BOM', () => {
        for (const order of ['le', 'be'] as const) {
            expectXmlError(utf16(ATTLIST_BODY, order, true));
            expectXmlError(utf16(`<!-- c -->\n${ATTLIST_BODY}`, order, true));
            expectXmlError(utf16(`<?xml version="1.0" encoding="UTF-16"?>${ATTLIST_BODY}`, order, false));
            expectXmlError(utf16(`<?xml version="1.0" encoding="UTF-16"?>${XMLNS_INJECTION}`, order, false));
        }
    });

    test('in declared ISO-8859-1', () => {
        expectXmlError(utf8(`<?xml version="1.0" encoding="ISO-8859-1"?>${ATTLIST_BODY}`));
    });

    test('in any letter case', () => {
        expectXmlError('<!doctype a><a/>');
    });

    test('DOCTYPE text inside a comment or CDATA is content, not a declaration', () => {
        expect(parsed('<!-- <!DOCTYPE a> --><a/>').name).toBe('a');
        expect(xmlText(parsed('<a><![CDATA[<!DOCTYPE x>]]></a>'))).toBe('<!DOCTYPE x>');
    });
});

describe('parseXml errors', () => {
    test('malformed input is an XmlError', () => {
        for (const input of [
            '<a>',
            '<a></b>',
            '<a/><b/>',
            '<a/>junk',
            'text',
            '<a x="1" x="2"/>',
            `${String.fromCharCode(0xa0)}<a/>`,
        ]) {
            expectXmlError(input);
        }
        expectXmlError(utf8('<?xml version="1.0" encoding="windows-1252"?><a/>'));
    });

    test('nesting deeper than Bun allows is an XmlError', () => {
        const depth = 100_000;
        expectXmlError(`${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`);
    });
});

describe('parseXml namespaces', () => {
    test('a prefixed element resolves through its declaration and keeps the name as written', () => {
        const root = parsed('<D:propfind xmlns:D="DAV:"><D:prop/></D:propfind>');
        expect(root).toMatchObject({ ns: 'DAV:', local: 'propfind', name: 'D:propfind' });
        expect(xmlChild(root, 'DAV:', 'prop')?.name).toBe('D:prop');
    });

    test('an arbitrary prefix and a default namespace resolve to the same element', () => {
        for (const body of [
            '<x:propfind xmlns:x="DAV:"><x:prop/></x:propfind>',
            '<propfind xmlns="DAV:"><prop/></propfind>',
        ]) {
            const root = parsed(body);
            expect(root).toMatchObject({ ns: 'DAV:', local: 'propfind' });
            expect(xmlChild(root, 'DAV:', 'prop')).toBeDefined();
        }
    });

    test('without a default namespace an unprefixed element has none', () => {
        expect(parsed('<a/>')).toMatchObject({ ns: '', local: 'a' });
    });

    test('the default namespace applies to elements, not attributes', () => {
        const root = parsed('<a xmlns="DAV:" x="1" D:y="2" xmlns:D="DAV:"/>');
        expect(root.ns).toBe('DAV:');
        expect(xmlAttr(root, '', 'x')).toBe('1');
        expect(xmlAttr(root, 'DAV:', 'x')).toBeUndefined();
        expect(xmlAttr(root, 'DAV:', 'y')).toBe('2');
    });

    test('a redeclaration on a child shadows the ancestor, for its subtree only', () => {
        const root = parsed(
            '<D:a xmlns:D="DAV:" xmlns="urn:one"><D:b xmlns:D="urn:other"><D:c/></D:b><D:d/><e xmlns=""/><f/></D:a>',
        );
        const [b, d, e, f] = xmlElements(root);
        expect(b.ns).toBe('urn:other');
        expect(xmlElements(b)[0].ns).toBe('urn:other');
        expect(d.ns).toBe('DAV:');
        expect(e.ns).toBe('');
        expect(f.ns).toBe('urn:one');
    });

    test('an unbound prefix is an error, on an element and on an attribute', () => {
        expectXmlError('<x:a/>');
        expectXmlError('<D:a xmlns:D="DAV:"><Z:b/></D:a>');
        expectXmlError('<a z:x="1"/>');
        expectXmlError('<a><b xmlns:p="u"/><p:c/></a>');
    });

    test('names and declarations Namespaces in XML forbids are errors', () => {
        expectXmlError('<a:b:c xmlns:a="u"/>');
        expectXmlError('<:a/>');
        expectXmlError('<a xmlns:p=""/>');
    });

    test('xml: is bound without a declaration (xml:lang, xml:space)', () => {
        const root = parsed(
            '<C:mkcalendar xmlns:C="urn:ietf:params:xml:ns:caldav"><C:displayname xml:lang="en">Work</C:displayname><w:t xmlns:w="urn:w" xml:space="preserve"> x </w:t></C:mkcalendar>',
        );
        const [name, run] = xmlElements(root);
        expect(xmlAttr(name, XML_NS, 'lang')).toBe('en');
        expect(xmlAttr(run, XML_NS, 'space')).toBe('preserve');
        expect(xmlText(run)).toBe(' x ');
    });

    test('a prefixed attribute resolves (an xlsx r:id)', () => {
        const root = parsed(
            '<workbook xmlns="urn:main" xmlns:r="urn:rel"><sheets><sheet name="One" r:id="rId1"/></sheets></workbook>',
        );
        const sheet = xmlChild(xmlChild(root, 'urn:main', 'sheets') ?? root, 'urn:main', 'sheet');
        expect(sheet && xmlAttr(sheet, 'urn:rel', 'id')).toBe('rId1');
        expect(sheet?.attributes['name']).toBe('One');
    });
});

describe('children and text', () => {
    test('finds children by namespace and local name, never by local name alone', () => {
        const root = parsed(
            '<D:prop xmlns:D="DAV:" xmlns:E="urn:evil"><E:getetag/><D:getetag/><D:href>1</D:href><D:href>2</D:href></D:prop>',
        );
        expect(xmlChild(root, 'DAV:', 'getetag')?.name).toBe('D:getetag');
        expect(xmlChildren(root, 'DAV:', 'href').map(xmlText)).toEqual(['1', '2']);
        expect(xmlChildren(root, 'urn:evil', 'href')).toEqual([]);
        expect(xmlChild(root, 'DAV:', 'missing')).toBeUndefined();
    });

    test('mixed content keeps document order', () => {
        const root = parsed('<p>a<b/>c<!--x--><d/>e<b/></p>');
        expect(root.children.map((c) => (typeof c === 'string' ? c : 'name' in c ? c.name : 'comment'))).toEqual([
            'a',
            'b',
            'c',
            'comment',
            'd',
            'e',
            'b',
        ]);
        expect(xmlElements(root).map((e) => e.name)).toEqual(['b', 'd', 'b']);
    });

    test('text is returned as written, whitespace kept and references decoded', () => {
        expect(xmlText(parsed('<a>\n  /dav/x \r\n</a>'))).toBe('\n  /dav/x \n');
        expect(xmlText(parsed('<a>&#48;612 &amp; &lt;&#x2013;</a>'))).toBe('0612 & <–');
        expect(xmlText(parsed('<a>one<b>skip</b>two</a>'))).toBe('onetwo');
        expect(xmlText(parsed('<a/>'))).toBe('');
    });
});

describe('serializeXmlChildren', () => {
    const lockinfo = (owner: string): XmlElement => {
        const root = parsed(
            `<D:lockinfo xmlns:D="DAV:" xmlns:Z="urn:z"><D:lockscope><D:exclusive/></D:lockscope><D:owner>${owner}</D:owner></D:lockinfo>`,
        );
        const element = xmlChild(root, 'DAV:', 'owner');
        if (!element) throw new Error('no owner');
        return element;
    };

    // The fragment stands alone in storage and inside our own envelope: it must parse there with the same names.
    const reparsed = (fragment: string): XmlElement => parsed(`<wrap>${fragment}</wrap>`);

    test('a prefix bound on an ancestor stays bound', () => {
        const fragment = serializeXmlChildren(lockinfo('<D:href>http://example.org/~ejw/contact.html</D:href>'));
        const href = xmlChild(reparsed(fragment), 'DAV:', 'href');
        expect(href?.name).toBe('D:href');
        expect(href && xmlText(href)).toBe('http://example.org/~ejw/contact.html');
    });

    test('a text-only child list comes back as escaped text', () => {
        const fragment = serializeXmlChildren(lockinfo(' mailto:a&amp;b@example.org &lt;x&gt; '));
        expect(fragment).toBe(' mailto:a&amp;b@example.org &lt;x&gt; ');
        expect(xmlText(reparsed(fragment))).toBe(' mailto:a&b@example.org <x> ');
    });

    test('mixed content keeps its order, and a child keeps its own shadowing declaration', () => {
        const element = lockinfo('Owner: <D:href>h</D:href>, see <Z:note xmlns:D="urn:shadow"><D:x/></Z:note>.');
        const root = reparsed(serializeXmlChildren(element));
        expect(root.children.filter((c) => typeof c === 'string')).toEqual(['Owner: ', ', see ', '.']);
        const [href, note] = xmlElements(root);
        expect(href).toMatchObject({ ns: 'DAV:', local: 'href' });
        expect(note).toMatchObject({ ns: 'urn:z', local: 'note' });
        expect(xmlElements(note)[0].ns).toBe('urn:shadow');
    });

    test('a default namespace in scope is declared on the child', () => {
        const root = parsed('<lockinfo xmlns="DAV:"><owner><href>h</href></owner></lockinfo>');
        const owner = xmlChild(root, 'DAV:', 'owner');
        const href = owner && xmlChild(reparsed(serializeXmlChildren(owner)), 'DAV:', 'href');
        expect(href?.name).toBe('href');
    });

    test('xml: is never declared', () => {
        const fragment = serializeXmlChildren(lockinfo('<D:href xml:lang="en">h</D:href>'));
        expect(fragment).not.toContain('xmlns:xml');
        const href = xmlChild(reparsed(fragment), 'DAV:', 'href');
        expect(href && xmlAttr(href, XML_NS, 'lang')).toBe('en');
    });

    test('an empty element has no content', () => {
        expect(serializeXmlChildren(lockinfo(''))).toBe('');
    });
});
