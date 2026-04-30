import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { ProtocolUser } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';
import { getHome } from '../home';
import { getTeam } from '../team/team';
import { getMemberships } from '../user';
import { buildXmlResponse, encodeHref, escapeXml, multistatus, propstatOk, response } from './xml';

const COLLECTION_PROP = '<D:resourcetype><D:collection/></D:resourcetype>';

// Many call sites in this file; the helper keeps each `response(...)` to a single
// line and avoids repeating the resourcetype + displayname boilerplate.
function collectionResponse(href: string, displayName: string): string {
    return response(href, [propstatOk([COLLECTION_PROP, `<D:displayname>${escapeXml(displayName)}</D:displayname>`])]);
}

export async function handleDiscoveryRoot(user: ProtocolUser): Promise<Response> {
    const memberships = await getMemberships(user.id);
    const teams = await Promise.all(
        memberships.teamIds.map(async (teamId) => {
            const team = await getTeam(teamId);
            return team ? { ownerId: teamOwnerId(teamId), name: team.name } : null;
        }),
    );

    const responses = [
        collectionResponse('/webdav/', 'WebDAV'),
        collectionResponse(`/webdav/${encodeHref(user.id)}/`, user.email),
        ...teams
            .filter((t): t is { ownerId: string; name: string } => t !== null)
            .map((t) => collectionResponse(`/webdav/${encodeHref(t.ownerId)}/`, t.name)),
    ];
    return buildXmlResponse(multistatus(responses));
}

export async function handleDiscoveryOwner(user: ProtocolUser, ownerId: string): Promise<Response> {
    if (ownerId !== user.id) {
        const parsed = parseOwnerId(ownerId);
        if (parsed.type !== 'team') {
            throw new ApiError(403, 'Forbidden');
        }
        const memberships = await getMemberships(user.id);
        if (!memberships.teamIds.includes(parsed.id)) {
            throw new ApiError(403, 'Forbidden');
        }
    }

    const home = await getHome(ownerId);
    const mounts = await home.drive.listMounts();

    const responses = [
        collectionResponse(`/webdav/${encodeHref(ownerId)}/`, ownerId),
        ...mounts.map((m) => collectionResponse(`/webdav/${encodeHref(ownerId)}/${encodeHref(m.id)}/`, m.name ?? m.id)),
    ];
    return buildXmlResponse(multistatus(responses));
}
