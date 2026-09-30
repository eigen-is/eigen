import { X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerArchiveSidecar } from '@workspace/lib/types/backup';
import { listServerArchives } from '../backup/server-job';
import { getRelayHost, isBundledCaddy, isMailEnabled } from './env';
import { getDataRoot } from './paths';
import { getDomain, getPublicConfig, isSetupRequired } from './server-config';
import { getServerSettings } from './server-settings';

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
    certSelfSigned: boolean;
    bundledCaddy: boolean;
    // What the Backup row is judged on. `newest` is the newest archive or refused attempt of any
    // reason, its state null when its record does not read.
    backup: {
        scheduleEnabled: boolean;
        newest: {
            name: string;
            createdAt: string;
            state: ServerArchiveSidecar['state'] | null;
            bytes: number | null;
            error: string | null;
        } | null;
        // The newest scheduled attempt, when it failed.
        scheduledFailure: { name: string; createdAt: string; error: string | null } | null;
        newestGoodFullAt: string | null;
    };
};

async function getBackupStatus(): Promise<ControlStatus['backup']> {
    const archives = await listServerArchives();
    const [newest] = archives;
    const scheduled = archives.find((archive) => archive.reason === 'scheduled');
    const goodFull = archives.find((archive) => archive.level !== 'light' && archive.record?.state === 'done');
    return {
        scheduleEnabled: getServerSettings().backups.schedule.enabled,
        newest: newest
            ? {
                  name: newest.name,
                  createdAt: newest.createdAt.toISOString(),
                  state: newest.record?.state ?? null,
                  bytes: newest.bytes,
                  error: newest.record?.error ?? null,
              }
            : null,
        scheduledFailure:
            scheduled?.record?.state === 'failed'
                ? {
                      name: scheduled.name,
                      createdAt: scheduled.createdAt.toISOString(),
                      error: scheduled.record.error ?? null,
                  }
                : null,
        newestGoodFullAt: goodFull?.createdAt.toISOString() ?? null,
    };
}

export async function getServerStatus(): Promise<ControlStatus> {
    const config = getPublicConfig();
    const disk = fs.statfsSync(getDataRoot());
    // Caddy's export-certs.sh copies its Let's Encrypt certificate here; without one, Postfix writes a self-signed stand-in.
    let certExpiresAt: string | null = null;
    let certSelfSigned = false;
    try {
        const cert = new X509Certificate(fs.readFileSync(path.join(getDataRoot(), 'certs', 'cert.pem')));
        certExpiresAt = new Date(cert.validTo).toISOString();
        certSelfSigned = cert.issuer === cert.subject;
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
        certSelfSigned,
        bundledCaddy: isBundledCaddy(),
        backup: await getBackupStatus(),
    };
}
