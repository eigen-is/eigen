import { describe, expect, test } from 'bun:test';
import { XML } from 'bun';
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
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
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

// Bun's own limit, found rather than assumed: the deepest nesting Bun.XML parses. It is Bun's native stack, so a
// call a few frames deeper gets a little less.
function bunMaxDepth(): number {
    let [low, high] = [1, 100_000];
    while (low < high) {
        const depth = Math.ceil((low + high) / 2);
        try {
            XML.parse(`${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`, { compact: false });
            low = depth;
        } catch {
            high = depth - 1;
        }
    }
    return low;
}

// What the tree keeps alive, counted after a full collection, so a cost shows up without a clock.
function retainedBytes(read: () => unknown): number {
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    const kept = read();
    Bun.gc(true);
    const retained = process.memoryUsage().heapUsed - before;
    expect(kept).toBeDefined();
    return retained;
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
        const depth = bunMaxDepth() + 1;
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

    test('a prefixed attribute is found by its whole local name', () => {
        const root = parsed('<a xmlns:D="DAV:" D:xval="1"/>');
        expect(xmlAttr(root, 'DAV:', 'val')).toBeUndefined();
        expect(xmlAttr(root, 'DAV:', 'xval')).toBe('1');
    });

    test('a declaration, a prefixed name and an inherited property are not attributes', () => {
        const root = parsed('<a xmlns="DAV:" xmlns:D="DAV:" D:x="1"/>');
        expect(xmlAttr(root, '', 'xmlns')).toBeUndefined();
        expect(xmlAttr(root, '', 'xmlns:D')).toBeUndefined();
        expect(xmlAttr(root, '', 'D:x')).toBeUndefined();
        expect(xmlAttr(root, 'DAV:', 'D:x')).toBeUndefined();
        expect(xmlAttr(root, '', 'constructor')).toBeUndefined();
        expect(xmlAttr(root, 'DAV:', 'D')).toBeUndefined();
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
        expectXmlError('<a xmlns:="urn:u"/>');
    });

    test('the reserved prefixes and namespaces are not rebound (Namespaces in XML § 3)', () => {
        expectXmlError('<a xmlns:xmlns="urn:x"/>');
        expectXmlError('<a xmlns:xml="urn:evil" xml:lang="en"/>');
        expectXmlError(`<a xmlns:p="${XML_NS}" p:lang="en"/>`);
        expectXmlError(`<a xmlns="${XML_NS}"/>`);
        expectXmlError(`<a xmlns:p="${XMLNS_NS}"/>`);
        expectXmlError(`<a xmlns="${XMLNS_NS}"/>`);
        expect(xmlAttr(parsed(`<a xmlns:xml="${XML_NS}" xml:lang="en"/>`), XML_NS, 'lang')).toBe('en');
    });

    test('two attributes with one expanded name are an error (Namespaces in XML § 6.3)', () => {
        expectXmlError('<a xmlns:p="urn:u" xmlns:q="urn:u" p:x="1" q:x="2"/>');
        const root = parsed('<a xmlns:p="urn:u" xmlns:q="urn:v" p:x="1" q:x="2" x="3"/>');
        expect([xmlAttr(root, 'urn:u', 'x'), xmlAttr(root, 'urn:v', 'x'), xmlAttr(root, '', 'x')]).toEqual([
            '1',
            '2',
            '3',
        ]);
    });

    test('a body costs its declarations once, not every binding in scope per declaring element', () => {
        const declarations = Array.from({ length: 500 }, (_, i) => `xmlns:p${i}="urn:${i}"`).join(' ');
        const body = `<r ${declarations}>${'<b xmlns:q="urn:q" q:x="1"/>'.repeat(10_000)}</r>`;
        let root: XmlElement | undefined;
        expect(retainedBytes(() => (root = parsed(body)))).toBeLessThan(128 * body.length);
        const last = root && xmlElements(root).at(-1);
        expect(last && xmlAttr(last, 'urn:q', 'x')).toBe('1');
    });

    test('undoing a declaration costs the declaration, not the bindings in scope, in parse and serialize', () => {
        // Against the same body without the root's bindings, so an undo that pays per binding in scope shows as a
        // multiple rather than as a clock this machine may or may not beat.
        const timed = (declarations: string): number => {
            const body = `<w><r ${declarations}>${'<b xmlns:q="urn:q"/>'.repeat(40_000)}</r></w>`;
            const start = performance.now();
            expect(serializeXmlChildren(parsed(body)).length).toBeLessThan(2 * body.length);
            return performance.now() - start;
        };
        const base = timed('');
        const declarations = Array.from({ length: 10_000 }, (_, i) => `xmlns:p${i}="urn:${i}"`).join(' ');
        expect(timed(declarations) / base).toBeLessThan(5);
    });

    test('resolves at the deepest nesting Bun reads, every level declaring a prefix', () => {
        const depth = bunMaxDepth() - 100;
        const levels = Array.from({ length: depth }, (_, i) => i);
        const body = `${levels.map((i) => `<p${i}:a xmlns:p${i}="urn:${i}">`).join('')}${levels
            .toReversed()
            .map((i) => `</p${i}:a>`)
            .join('')}`;
        let root: XmlElement | undefined;
        expect(retainedBytes(() => (root = parsed(body)))).toBeLessThan(128 * body.length);
        let deepest = root;
        while (deepest && xmlElements(deepest).length > 0) deepest = xmlElements(deepest)[0];
        expect(deepest).toMatchObject({ ns: `urn:${depth - 1}`, local: 'a' });
        // Each level declares its own prefix, so the fragment is the body inside the root, the leaf written empty.
        const inside = body.slice('<p0:a xmlns:p0="urn:0">'.length, -'</p0:a>'.length);
        expect(root && serializeXmlChildren(root)).toBe(inside.replace(`></p${depth - 1}:a>`, '/>'));
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

    test('a copied element keeps its attribute namespaces', () => {
        const root = parsed('<D:x xmlns:D="DAV:" D:a="1" xml:lang="en"/>');
        for (const copy of [{ ...root }, structuredClone(root)]) {
            expect(xmlAttr(copy, 'DAV:', 'a')).toBe('1');
            expect(xmlAttr(copy, XML_NS, 'lang')).toBe('en');
        }
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

    // The fragment stands alone in storage and inside our own envelope, whose bindings must not leak into it.
    const reparsed = (fragment: string): XmlElement =>
        parsed(`<wrap xmlns="urn:other" xmlns:D="urn:other" xmlns:Z="urn:other">${fragment}</wrap>`);

    const expandedNames = (element: XmlElement): string[] =>
        xmlElements(element).flatMap((child) => [`{${child.ns}}${child.local}`, ...expandedNames(child)]);

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

    test('inside an envelope every element keeps its expanded name, an unprefixed one included', () => {
        for (const body of [
            '<D:r xmlns:D="DAV:"><Z:p xmlns:Z="urn:z"><v>1</v><D:w><x/></D:w></Z:p></D:r>',
            '<r xmlns="DAV:"><p><v/>t<Z:w xmlns:Z="urn:z"><x/><y xmlns=""><z/></y></Z:w></p></r>',
            '<D:r xmlns:D="DAV:" xmlns="urn:d"><p><D:v><w xmlns="urn:e"><x/></w><y/></D:v>t<D:z/></p></D:r>',
        ]) {
            const element = xmlElements(parsed(body))[0];
            expect(expandedNames(reparsed(serializeXmlChildren(element)))).toEqual(expandedNames(element));
        }
    });

    test('a child declares only the bindings its subtree uses, an attribute prefix included', () => {
        expect(serializeXmlChildren(lockinfo('<D:href>h</D:href>'))).toBe('<D:href xmlns:D="DAV:">h</D:href>');
        const fragment = serializeXmlChildren(lockinfo('<D:href><D:x Z:a="1"/></D:href>'));
        expect(fragment).toBe('<D:href xmlns:D="DAV:" xmlns:Z="urn:z"><D:x Z:a="1"/></D:href>');
        const x = xmlElements(xmlElements(reparsed(fragment))[0])[0];
        expect(xmlAttr(x, 'urn:z', 'a')).toBe('1');
    });

    test('output grows with the content, not with the bindings in scope', () => {
        const declarations = Array.from({ length: 200 }, (_, i) => `xmlns:p${i}="urn:${i}"`).join(' ');
        const body = `<D:prop xmlns:D="DAV:" ${declarations}><D:v>${'<D:a/>'.repeat(1000)}<a/></D:v></D:prop>`;
        const value = xmlChild(parsed(body), 'DAV:', 'v');
        expect(value && serializeXmlChildren(value).length).toBeLessThan(4 * body.length);
        // Every child declares `xmlns=""`: more bytes than each child, still a constant factor.
        const empty = `<D:v xmlns:D="DAV:">${'<a/>'.repeat(100_000)}</D:v>`;
        expect(serializeXmlChildren(parsed(empty)).length).toBeLessThan(4 * empty.length);
    });

    test('a long namespace URI that many children would each declare is an error, not a copy per child', () => {
        const uri = `urn:${'x'.repeat(500_000)}`;
        const body = `<D:prop xmlns:D="DAV:" xmlns:p="${uri}"><D:v>${'<p:a/>'.repeat(10)}</D:v></D:prop>`;
        const value = xmlChild(parsed(body), 'DAV:', 'v');
        expect(() => value && serializeXmlChildren(value)).toThrow(XmlError);
        expect(serializeXmlChildren(parsed(`<D:v xmlns:D="DAV:" xmlns:p="${uri}"><p:a/><p:a/></D:v>`))).toContain(uri);
    });

    test('a short URI that every one of many small children declares is no error', () => {
        const uri = `urn:${'x'.repeat(31)}`;
        const body = `<D:v xmlns:D="DAV:" xmlns:Z="${uri}">${'<Z:i>1</Z:i>'.repeat(3000)}</D:v>`;
        const fragment = serializeXmlChildren(parsed(body));
        expect(fragment.split(`<Z:i xmlns:Z="${uri}">1</Z:i>`)).toHaveLength(3001);
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
