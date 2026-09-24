import { X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRelayHost, isMailEnabled } from './env';
import { getDataRoot } from './paths';
import { getDomain, getPublicConfig, isSetupRequired } from './server-config';

export type ControlStatus = {
    version: string;
    commit: string | null;
    builtAt: string | null;
    setupRequired: boolean;
    mailEnabled: boolean;
    relayHost: string | null;
    domain: string;
    diskFree: number;
    diskTotal: number;
    certExpiresAt: string | null;
};

export function getServerStatus(): ControlStatus {
    const config = getPublicConfig();
    const disk = fs.statfsSync(getDataRoot());
    // Caddy's export-certs.sh copies the certificate here; a server behind its own web server has none.
    let certExpiresAt: string | null = null;
    try {
        const cert = new X509Certificate(fs.readFileSync(path.join(getDataRoot(), 'certs', 'cert.pem')));
        certExpiresAt = new Date(cert.validTo).toISOString();
    } catch {
        // No certificate, or a file that is not one: the report says none rather than failing whole.
    }
    return {
        version: config.version,
        commit: config.commit ?? null,
        builtAt: config.builtAt?.toISOString() ?? null,
        setupRequired: isSetupRequired(),
        mailEnabled: isMailEnabled(),
        relayHost: isMailEnabled() ? null : (getRelayHost() ?? null),
        domain: getDomain(),
        diskFree: disk.bavail * disk.bsize,
        diskTotal: disk.blocks * disk.bsize,
        certExpiresAt,
    };
}
