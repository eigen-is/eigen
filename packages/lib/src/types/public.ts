// What anyone may learn without signing in, from the /p/ routes: who a user is, so a share dialog or a comment can
// show them, and the server's own config, such as its name, its version and what it offers before a login.

import type { LandingLink } from './settings';

export type PublicUser = {
    name?: string;
    email: string;
    avatar?: string;
};

export type PublicConfig = {
    domain: string;
    mailDomain: string;
    orgName: string;
    orgId: string;
    defaultTeamId?: string;
    version: string;
    commit?: string;
    builtAt?: Date;
    waitlistEnabled: boolean;
    landingLinks: LandingLink[];
    showInstall: boolean;
    demoMode: boolean;
    mailEnabled: boolean;
    publicLinks: boolean;
};
