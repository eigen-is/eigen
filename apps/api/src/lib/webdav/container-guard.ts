import { type DrivePath, isDocumentType } from '@workspace/lib/types/drive';

// Returns the nearest enclosing Eigen document container (DOC, STICKIES,
// SLIDES, SHEETS, CHAT) along the breadcrumb, or null. Plain folders never
// match. Used by WebDAV to gate writes that would land inside a managed
// container — those resources have app-managed internal state (data.db,
// media/) that the drive layer owns, so client-driven PUT/MKCOL/DELETE there
// would corrupt or orphan rows. Reads (PROPFIND, GET, COPY-out) stay open.
//
// includeSelf:
//   false — "is this resource inside a container?" (DELETE, MOVE source,
//           PROPPATCH, overwrite-PUT existing): the resource itself being a
//           container is fine; we care about its ancestors.
//   true  — "are writes INTO this resource blocked?" (MKCOL parent,
//           PUT new-file parent, MOVE/COPY destParent): the resource itself
//           being a container blocks creating children inside it.
export function enclosingDocumentContainer(breadcrumb: DrivePath[], opts: { includeSelf: boolean }): DrivePath | null {
    const slice = opts.includeSelf ? breadcrumb : breadcrumb.slice(0, -1);
    return slice.find((p) => isDocumentType(p.type)) ?? null;
}
