// The questions another home may ask of a drive, such as which paths a user watches there, each with the handler that
// answers it on the owner's Home. Callers ask through the home relay's getFromHomes. The relay joins this table with
// its own when it loads, so this file imports types only: a value import that led back to the relay would find it
// half-built.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { Answerers } from '../home/home-relay';
import type { User } from '../user';

export type DriveQueries = {
    'drive:watches': { ask: { user: User }; answer: DrivePath[] };
};

export const answerDrive: Answerers<DriveQueries> = {
    'drive:watches': (home, ask) => home.drive.getWatches(ask.user),
};
