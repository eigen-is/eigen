import { describe, expect, test } from 'bun:test';
import { PACKAGE_RELATIONSHIPS_NS, parseOoxml } from '../../lib/core/ooxml';
import { relationshipsOf, relOfType, relsPathOf } from '../../lib/core/opc';

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

    test('a relationship without an Id is skipped; one without a Target or Type names the source folder', () => {
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
