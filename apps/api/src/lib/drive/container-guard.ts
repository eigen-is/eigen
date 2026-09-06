import { type DrivePath, isDocumentType } from '@workspace/lib/types/drive';
import type { DriveLike } from './get-drive';

// Guards that keep an Eigen document container's app-managed internals (data.db,
// comments.db, media/) off the client-facing write surface. Shared by the WebDAV
// layer and the inline-editor save route so both refuse the same shapes. Reads stay open.

// Returns the nearest enclosing Eigen document container (DOC, STICKIES,
// SLIDES, SHEETS, CHAT) along the breadcrumb, or null. Plain folders never
// match. Used to gate writes that would land inside a managed container — those
// resources have app-managed internal state that the drive layer owns, so a
// client-driven PUT/MKCOL/DELETE/save there would corrupt or orphan rows.
//
// includeSelf:
//   false — "is this resource inside a container?" (DELETE, MOVE source,
//           PROPPATCH, overwrite-PUT existing, inline-editor save): the resource
//           itself being a container is fine; we care about its ancestors.
//   true  — "are writes INTO this resource blocked?" (MKCOL parent,
//           PUT new-file parent, MOVE/COPY destParent): the resource itself
//           being a container blocks creating children inside it.
export function enclosingDocumentContainer(breadcrumb: DrivePath[], opts: { includeSelf: boolean }): DrivePath | null {
    const slice = opts.includeSelf ? breadcrumb : breadcrumb.slice(0, -1);
    return slice.find((p) => isDocumentType(p.type)) ?? null;
}
