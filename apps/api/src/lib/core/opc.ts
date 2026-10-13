import { PACKAGE_RELATIONSHIPS_NS } from './ooxml';
import { is, type XmlElement, xmlElements } from './xml';

// The Open Packaging Conventions every OOXML format shares: a part's relationships and the part names they resolve to.

export type Relationship = { type: string; target: string; external: boolean };

// '' is the package itself, whose relationships are _rels/.rels.
export function relsPathOf(partPath: string): string {
    const slash = partPath.lastIndexOf('/');
    return `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
}

// An internal target is resolved to a part name; an External one is kept as written.
export function relationshipsOf(root: XmlElement | undefined, partPath: string): Map<string, Relationship> {
    const rels = new Map<string, Relationship>();
    for (const rel of root ? xmlElements(root) : []) {
        const id = rel.attributes['Id'];
        if (!is(rel, PACKAGE_RELATIONSHIPS_NS, 'Relationship') || !id) continue;
        const target = rel.attributes['Target'] ?? '';
        const external = rel.attributes['TargetMode'] === 'External';
        rels.set(id, {
            type: rel.attributes['Type'] ?? '',
            target: external ? target : resolveTarget(partPath, target),
            external,
        });
    }
    return rels;
}

// By the type's last segment, so a Strict package's relationship types match too.
export function relOfType(rels: ReadonlyMap<string, Relationship>, type: string): string | undefined {
    for (const rel of rels.values()) if (rel.type.endsWith(`/${type}`) && !rel.external) return rel.target;
    return undefined;
}

function resolveTarget(base: string, target: string): string {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/').slice(0, -1);
    for (const segment of target.split('/')) {
        if (segment === '..') parts.pop();
        else if (segment !== '.' && segment !== '') parts.push(segment);
    }
    return parts.join('/');
}
