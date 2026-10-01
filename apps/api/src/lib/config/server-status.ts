import { X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerArchive, ServerArchiveSidecar } from '@workspace/lib/types/backup';
import { canUploadServerArchive } from '@workspace/lib/validation';
import { listBackupJobs } from '../backup/jobs';
import { listServerArchives } from '../backup/server-archives';
import { getRelayHost, isBundledCaddy, isMailEnabled } from './env';
import { CERT_FILES, CERTS_DIR, getDataRoot } from './paths';
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
        newest: (ArchiveLine & { state: ServerArchiveSidecar['state'] | null; bytes: number | null }) | null;
        // The newest scheduled attempt, when it failed.
        scheduledFailure: ArchiveLine | null;
        // The newest scheduled attempt, when its archive is here but not in the bucket: its last upload failed, or
        // the owner could upload it and no upload was tried, as when a restart cut in between.
        scheduledNotUploaded: ArchiveLine | null;
        newestGoodFullAt: string | null;
    };
};

type ArchiveLine = { name: string; createdAt: string; error: string | null };

function line({ name, createdAt }: ServerArchive, error: string | undefined): ArchiveLine {
    return { name, createdAt: createdAt.toISOString(), error: error ?? null };
}

async function getBackupStatus(): Promise<ControlStatus['backup']> {
    const archives = await listServerArchives();
    const [newest] = archives;
    const scheduled = archives.find((archive) => archive.reason === 'scheduled');
    const goodFull = archives.find((archive) => archive.level !== 'light' && archive.record?.state === 'done');
    const { schedule, upload } = getServerSettings().backups;
    const notUploaded =
        scheduled &&
        (scheduled.record?.upload?.state === 'failed' ||
            (!scheduled.record?.upload &&
                canUploadServerArchive(scheduled, { uploadEnabled: upload.enabled, jobs: listBackupJobs() })));
    return {
        scheduleEnabled: schedule.enabled,
        newest: newest
            ? { ...line(newest, newest.record?.error), state: newest.record?.state ?? null, bytes: newest.bytes }
            : null,
        scheduledFailure: scheduled?.record?.state === 'failed' ? line(scheduled, scheduled.record.error) : null,
        scheduledNotUploaded: notUploaded ? line(scheduled, scheduled.record?.upload?.error) : null,
        newestGoodFullAt: goodFull?.createdAt.toISOString() ?? null,
    };
}

export async function getServerStatus(): Promise<ControlStatus> {
    const config = getPublicConfig();
    const disk = fs.statfsSync(getDataRoot());
    // Caddy's export-certs.sh copies its Let's Encrypt certificate here; without one, Dovecot writes a self-signed stand-in.
    let certExpiresAt: string | null = null;
    let certSelfSigned = false;
    try {
        const cert = new X509Certificate(fs.readFileSync(path.join(getDataRoot(), CERTS_DIR, CERT_FILES.cert)));
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
