// The questions another home may ask of a drive, such as which paths a user watches there, each with the handler that
// answers it on the owner's Home. Callers ask through the home relay's getFromHomes. This file imports types only,
// which `bun run check` gates.

import type { DrivePath, DrivePathRef } from '@workspace/lib/types/drive';
import type { Answerers } from '../home/home-relay';
import type { Memberships, User } from '../user';

export type DriveQueries = {
    'drive:watches': { ask: { user: User }; answer: DrivePath[] };
    'drive:visible-paths': {
        ask: {
            user: User;
            memberships: Memberships;
            rows: readonly DrivePathRef[];
            mimeTypePrefix: string;
        };
        answer: DrivePath[];
    };
    'drive:shared-with': { ask: { user: User }; answer: DrivePath[] };
    'drive:mime-contents': { ask: { mimeType: string }; answer: DrivePath[] };
    'drive:search': { ask: { q: string; limit: number }; answer: DrivePath[] };
};

// The kinds that list a whole drive check no user, since a member may read all of a team's drive and their callers
// ask only the user's own teams.
export const answerDrive: Answerers<DriveQueries> = {
    'drive:watches': (home, ask) => home.drive.getWatches(ask.user),
    'drive:visible-paths': (home, ask) =>
        home.drive.getVisiblePaths(
            ask.user,
            ask.memberships,
            ask.rows.filter((row) => row.ownerId === home.user.id),
            ask.mimeTypePrefix,
        ),
    'drive:shared-with': (home, ask) => home.drive.getAllSharedWith(ask.user),
    'drive:mime-contents': (home, ask) => home.drive.getMimeTypeContents(ask.mimeType),
    'drive:search': async (home, ask) => home.drive.search(ask),
};
