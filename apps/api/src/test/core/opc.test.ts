import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ApiError } from '../../lib/core/errors';
import { CONTENT_TYPES_NS, PACKAGE_RELATIONSHIPS_NS, parseOoxml } from '../../lib/core/ooxml';
import {
    isEncryptedPackage,
    MAX_PACKAGE_XML_BYTES,
    MAX_PACKAGE_XML_TAGS,
    openPackage,
    optional,
    relationshipsOf,
    relationshipsXml,
    relOfType,
    relsPathOf,
    relTarget,
    writePackage,
} from '../../lib/core/opc';
import * as xml from '../../lib/core/xml';
import { XmlError } from '../../lib/core/xml';
import { openZip, writeZip, ZipError, ZipReader } from '../../lib/core/zip';
import { build, deflated } from '../fixtures/raw-zip';

const MESSAGES = { passwordProtected: 'Locked', tooLarge: 'Too large' };
const IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

function rels(relationships: string, partPath = 'word/document.xml') {
    const root = parseOoxml(`<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NS}">${relationships}</Relationships>`);
    if (!root) throw new Error('no root');
    return relationshipsOf(root, partPath);
}

const targetOf = (target: string, partPath?: string) =>
    rels(`<Relationship Id="rId1" Type="${IMAGE}" Target="${target}"/>`, partPath).get('rId1')?.target;

describe('the relationships part of a part', () => {
    test('sits in _rels beside it, the package itself at the root', () => {
        expect(relsPathOf('word/document.xml')).toBe('word/_rels/document.xml.rels');
        expect(relsPathOf('xl/worksheets/sheet1.xml')).toBe('xl/worksheets/_rels/sheet1.xml.rels');
        expect(relsPathOf('')).toBe('_rels/.rels');
    });
});

describe('a relationship target', () => {
    test('is resolved against the source part', () => {
        expect(targetOf('media/x.png')).toBe('word/media/x.png');
        expect(targetOf('./media/x.png')).toBe('word/media/x.png');
        expect(targetOf('word/document.xml', '')).toBe('word/document.xml');
    });

    test("'..' climbs out of the source part's folder", () => {
        expect(targetOf('../media/x.png')).toBe('media/x.png');
        expect(targetOf('../../x.png', 'xl/worksheets/sheet1.xml')).toBe('x.png');
    });

    test('an absolute target is a part name from the package root', () => {
        expect(targetOf('/word/media/x.png', 'word/glossary/document.xml')).toBe('word/media/x.png');
    });

    // A '..' kept would pass a format's prefix check on a part outside its folder.
    test("an absolute target's '.' and '..' are resolved from the root, never above it", () => {
        expect(targetOf('/ppt/../evil.xml', 'ppt/slides/slide1.xml')).toBe('evil.xml');
        expect(targetOf('/../../word/./x.png')).toBe('word/x.png');
    });

    // A part name is a URI: a space in an entry's name is %20 in its target, and a malformed escape is no escape.
    test("an internal target's escapes are decoded, a malformed one kept as written", () => {
        expect(targetOf('worksheets/sheet%201.xml', 'xl/workbook.xml')).toBe('xl/worksheets/sheet 1.xml');
        expect(targetOf('media/caf%C3%A9%2.png')).toBe('word/media/café%2.png');
        expect(targetOf('media/%E9%zz.png')).toBe('word/media/%E9%zz.png');
        expect(targetOf('%2E%2E/x.png', 'xl/worksheets/sheet1.xml')).toBe('xl/x.png');
        expect(targetOf('media/%2E%2E%2F%2E%2E%2Fevil.xml')).toBe('word/media/%2E%2E%2F%2E%2E%2Fevil.xml');
    });

    test('an External target is kept as written, and is no part', () => {
        const external = rels(
            `<Relationship Id="rId1" Type="${IMAGE}" Target="https://example.com/x.png" TargetMode="External"/>`,
        );
        expect(external.get('rId1')).toEqual({ type: IMAGE, target: 'https://example.com/x.png', external: true });
        expect(relOfType(external, 'image')).toBeUndefined();
    });

    // Today's output, not a contract: no reader uses a relationship without a Target.
    test('a relationship without an Id is skipped; one without a Target or Type reads as the source folder', () => {
        const read = rels(`<Relationship Type="${IMAGE}" Target="media/x.png"/><Relationship Id="rId2"/>`);
        expect([...read]).toEqual([['rId2', { type: '', target: 'word', external: false }]]);
    });

    test('no relationships part is no relationships', () => {
        expect(relationshipsOf(undefined, 'word/document.xml').size).toBe(0);
    });
});

describe('the relationship of a type', () => {
    test("is the first internal one whose type ends in it, Strict's too", () => {
        const read = rels(
            `<Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${IMAGE}" Target="a.png"/><Relationship Id="rId3" Type="${IMAGE}" Target="b.png"/>`,
        );
        expect(relOfType(read, 'styles')).toBe('word/styles.xml');
        expect(relOfType(read, 'image')).toBe('word/a.png');
        expect(relOfType(read, 'numbering')).toBeUndefined();
    });
});

describe('the relationship of an id', () => {
    test("is the part it names when internal and of the type, Strict's too", () => {
        const read = rels(
            `<Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/image" Target="a.png"/><Relationship Id="rId2" Type="${IMAGE}" Target="https://example.com/b.png" TargetMode="External"/>`,
        );
        expect(relTarget(read, 'rId1', 'image')).toBe('word/a.png');
        expect(relTarget(read, 'rId1', 'chart')).toBeUndefined();
        expect(relTarget(read, 'rId2', 'image')).toBeUndefined();
        expect(relTarget(read, 'rId3', 'image')).toBeUndefined();
        expect(relTarget(read, undefined, 'image')).toBeUndefined();
    });
});

describe('a package', () => {
    const CONTENT_TYPES = `<Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="xml" ContentType="Application/XML"/><Override PartName="/a/b.xml" ContentType="text/b"/></Types>`;
    const ROOT_RELS = `<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NS}"><Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="a/b.xml"/></Relationships>`;
    const zip = (files: Record<string, string>) =>
        writeZip(Object.entries(files).map(([name, data]) => ({ name, data })));
    const open = (files: Record<string, string>) => openPackage(zip(files), MESSAGES);
    // An OLE compound file: its signature, then a directory entry naming a stream in UTF-16.
    const ole = (stream: string) => {
        const bytes = new Uint8Array(4096);
        bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        bytes.set(Buffer.from(stream, 'utf16le'), 1024);
        return bytes;
    };
    const thrown = (run: () => unknown): unknown => {
        try {
            run();
        } catch (error) {
            return error;
        }
        throw new Error('expected a throw');
    };

    test("an encrypted one is refused with the format's message; any other OLE file is no zip", () => {
        expect(isEncryptedPackage(ole('EncryptedPackage'))).toBe(true);
        expect(isEncryptedPackage(ole('Workbook'))).toBe(false);
        const locked = thrown(() => openPackage(ole('EncryptedPackage'), MESSAGES));
        expect(locked).toBeInstanceOf(ApiError);
        expect(locked).toMatchObject({ status: 400, message: 'Locked' });
        expect(thrown(() => openPackage(ole('Workbook'), MESSAGES))).toBeInstanceOf(ZipError);
    });

    test('reads a part once, and its relationships, the package\'s own under ""', () => {
        const pkg = open({ '[Content_Types].xml': CONTENT_TYPES, '_rels/.rels': ROOT_RELS, 'a/b.xml': '<b/>' });
        const part = relOfType(pkg.relationships(''), 'officeDocument');
        expect(part).toBe('a/b.xml');
        expect(pkg.part('a/b.xml')?.local).toBe('b');
        expect(pkg.part('a/b.xml')).toBe(pkg.part('a/b.xml'));
        expect(pkg.part('a/missing.xml')).toBeUndefined();
        expect(pkg.relationships('a/b.xml').size).toBe(0);
    });

    test('a part that fails throws the same error to every reader, and parses no second time', () => {
        const pkg = open({ 'a/b.xml': '<b>' });
        const first = thrown(() => pkg.part('a/b.xml'));
        expect(first).toBeInstanceOf(XmlError);
        expect(thrown(() => pkg.part('a/b.xml'))).toBe(first);
    });

    test('names a content type by override, else by extension, case-insensitively', () => {
        const pkg = open({ '[Content_Types].xml': CONTENT_TYPES });
        expect(pkg.contentTypeOf('a/b.xml')).toBe('text/b');
        expect(pkg.contentTypeOf('a/c.XML')).toBe('application/xml');
        expect(pkg.contentTypeOf('a/c.png')).toBeUndefined();
    });

    test('an optional read is undefined for damaged XML or a damaged entry, and a cap still refuses', () => {
        expect(optional(() => parseOoxml('<b>'))).toBeUndefined();
        expect(optional(() => thrownBy(new ZipError('bad-crc')))).toBeUndefined();
        expect(thrown(() => optional(() => thrownBy(new ZipError('too-large'))))).toBeInstanceOf(ZipError);
        expect(thrown(() => optional(() => thrownBy(new ApiError(413, 'Too large'))))).toBeInstanceOf(ApiError);
        expect(optional(() => 1)).toBe(1);
    });
});

describe("a package's parse budget", () => {
    const spies: { mockRestore(): void }[] = [];
    afterEach(() => {
        for (const spy of spies) spy.mockRestore();
        spies.length = 0;
    });
    const comment = (bytes: number) => `<a><!--${'x'.repeat(bytes)}--></a>`;
    const pkg = (files: Record<string, string>) =>
        openPackage(build(Object.entries(files).map(([name, data]) => deflated(name, data))), MESSAGES);
    const refusal = (run: () => unknown) => {
        try {
            run();
        } catch (error) {
            return error instanceof ApiError ? [error.status, error.message] : error;
        }
        return undefined;
    };

    test('a part past the bytes left is 413 before it inflates', () => {
        const reads = spyOn(ZipReader.prototype, 'read');
        spies.push(reads);
        const half = MAX_PACKAGE_XML_BYTES / 2;
        const opened = pkg({ 'a.xml': comment(half), 'b.xml': comment(half) });
        expect(opened.part('a.xml')?.local).toBe('a');
        expect(refusal(() => opened.part('b.xml'))).toEqual([413, 'Too large']);
        expect(reads.mock.calls.map(([name]) => name)).not.toContain('b.xml');
    });

    test('the parts past the tags left are 413 before they parse', () => {
        const parses = spyOn(xml, 'parseXml');
        spies.push(parses);
        const tags = (count: number) => `<a>${'<b/>'.repeat(count - 2)}</a>`;
        const opened = pkg({ 'a.xml': tags(MAX_PACKAGE_XML_TAGS / 2), 'b.xml': tags(MAX_PACKAGE_XML_TAGS / 2 + 1) });
        expect(opened.part('a.xml')?.local).toBe('a');
        const parsed = parses.mock.calls.length;
        expect(refusal(() => opened.part('b.xml'))).toEqual([413, 'Too large']);
        expect(parses.mock.calls.length).toBe(parsed);
    });

    test('[Content_Types].xml and the relationships parts are charged too', () => {
        const types = `<Types xmlns="${CONTENT_TYPES_NS}">${comment(MAX_PACKAGE_XML_BYTES - 1000)}</Types>`;
        const opened = pkg({ '[Content_Types].xml': types, '_rels/.rels': comment(1000), 'a.xml': '<a/>' });
        expect(refusal(() => opened.relationships(''))).toEqual([413, 'Too large']);
    });

    // 1 MB of upload: the declared size is the budget's to read, so not a byte of it inflates.
    test('a [Content_Types].xml that inflates to 180 MB is 413 at once', () => {
        const reads = spyOn(ZipReader.prototype, 'read');
        spies.push(reads);
        const bomb = build([deflated('[Content_Types].xml', comment(180 * 1024 * 1024))]);
        expect(bomb.length).toBeLessThan(1024 * 1024);
        const started = performance.now();
        expect(refusal(() => openPackage(bomb, MESSAGES))).toEqual([413, 'Too large']);
        expect(performance.now() - started).toBeLessThan(100);
        expect(reads).not.toHaveBeenCalled();
    });
});

describe('written relationships', () => {
    test("are numbered by place, with each target escaped and an External one's mode", () => {
        const xml = relationshipsXml([
            { type: IMAGE, target: 'media/a&b"<1>.png' },
            { type: IMAGE, target: 'https://example.com/?a=1&b=2', external: true },
            { type: IMAGE, target: 'media/c.png', external: false },
        ]);
        expect(xml).toBe(
            `<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NS}"><Relationship Id="rId1" Type="${IMAGE}" Target="media/a&amp;b&quot;&lt;1&gt;.png"/><Relationship Id="rId2" Type="${IMAGE}" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"/><Relationship Id="rId3" Type="${IMAGE}" Target="media/c.png"/></Relationships>`,
        );
    });

    test('read back as written, an internal target resolved', () => {
        const xml = relationshipsXml([
            { type: IMAGE, target: 'media/a&b.png' },
            { type: IMAGE, target: 'https://example.com/x', external: true },
        ]);
        expect([...rels(xml.replace(/^<Relationships[^>]*>|<\/Relationships>$/g, ''))]).toEqual([
            ['rId1', { type: IMAGE, target: 'word/media/a&b.png', external: false }],
            ['rId2', { type: IMAGE, target: 'https://example.com/x', external: true }],
        ]);
    });
});

describe('a written package', () => {
    const decoder = new TextDecoder();
    const write = (title = 'Report') =>
        writePackage({
            main: 'doc/main.xml',
            title,
            defaults: { png: 'image/png', bin: 'application/x-test' },
            parts: [
                ['doc/main.xml', '<main/>', 'text/main'],
                ['doc/_rels/main.xml.rels', relationshipsXml([{ type: IMAGE, target: 'media/a.png' }])],
                ['doc/other.xml', '<other/>', 'text/other'],
            ],
            files: [
                { name: 'doc/media/a.png', data: new Uint8Array([1, 2, 3]), store: true },
                { name: 'doc/data.bin', data: 'data' },
            ],
        });

    test('zips the content types, the package relationships and core properties, the parts, then the files', () => {
        const zip = openZip(write());
        expect(zip.names()).toEqual([
            '[Content_Types].xml',
            '_rels/.rels',
            'docProps/core.xml',
            'doc/main.xml',
            'doc/_rels/main.xml.rels',
            'doc/other.xml',
            'doc/media/a.png',
            'doc/data.bin',
        ]);
        const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
        for (const name of zip.names().slice(0, 6)) expect(decoder.decode(zip.read(name))).toStartWith(declaration);
        expect([...(zip.read('doc/media/a.png') ?? [])]).toEqual([1, 2, 3]);
        expect(decoder.decode(zip.read('doc/data.bin'))).toBe('data');
    });

    test("writes the package's Defaults, the format's after them, then an Override for each typed part in order", () => {
        const types = decoder.decode(openZip(write()).read('[Content_Types].xml'));
        expect(types).toEndWith(
            `<Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="application/x-test"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/doc/main.xml" ContentType="text/main"/><Override PartName="/doc/other.xml" ContentType="text/other"/></Types>`,
        );
    });

    test('reads back: the main part, its relationships, the content types and the escaped title', () => {
        const pkg = openPackage(write('A & <B>'), MESSAGES);
        expect(relOfType(pkg.relationships(''), 'officeDocument')).toBe('doc/main.xml');
        expect(relOfType(pkg.relationships('doc/main.xml'), 'image')).toBe('doc/media/a.png');
        expect(pkg.contentTypeOf('doc/main.xml')).toBe('text/main');
        expect(pkg.contentTypeOf('doc/_rels/main.xml.rels')).toBe(
            'application/vnd.openxmlformats-package.relationships+xml',
        );
        expect(pkg.contentTypeOf('doc/data.bin')).toBe('application/x-test');
        const core = relOfType(pkg.relationships(''), 'core-properties');
        expect(core).toBe('docProps/core.xml');
        expect(decoder.decode(pkg.zip.read('docProps/core.xml'))).toContain('<dc:title>A &amp; &lt;B&gt;</dc:title>');
    });

    test('is the same bytes for the same input', () => {
        expect(Buffer.from(write()).equals(Buffer.from(write()))).toBe(true);
    });
});

function thrownBy(error: unknown): never {
    throw error;
}
