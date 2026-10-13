import { describe, expect, test } from 'bun:test';
import { ApiError } from '../../lib/core/errors';
import { CONTENT_TYPES_NS, PACKAGE_RELATIONSHIPS_NS, parseOoxml } from '../../lib/core/ooxml';
import { isEncryptedPackage, openPackage, optional, relationshipsOf, relOfType, relsPathOf } from '../../lib/core/opc';
import { XmlError } from '../../lib/core/xml';
import { writeZip, ZipError } from '../../lib/core/zip';

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

describe('a package', () => {
    const CONTENT_TYPES = `<Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="xml" ContentType="Application/XML"/><Override PartName="/a/b.xml" ContentType="text/b"/></Types>`;
    const ROOT_RELS = `<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NS}"><Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="a/b.xml"/></Relationships>`;
    const zip = (files: Record<string, string>) =>
        writeZip(Object.entries(files).map(([name, data]) => ({ name, data })));
    const open = (files: Record<string, string>) => openPackage(zip(files), 'Locked');
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
        const locked = thrown(() => openPackage(ole('EncryptedPackage'), 'Locked'));
        expect(locked).toBeInstanceOf(ApiError);
        expect(locked).toMatchObject({ status: 400, message: 'Locked' });
        expect(thrown(() => openPackage(ole('Workbook'), 'Locked'))).toBeInstanceOf(ZipError);
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

function thrownBy(error: unknown): never {
    throw error;
}
