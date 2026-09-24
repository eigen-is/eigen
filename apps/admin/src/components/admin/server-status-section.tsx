import { formatDate } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import { useServerStatus } from '@workspace/lib/settings';
import { SettingsSection } from '@workspace/ui';
import { Separator } from '@workspace/ui/components/separator';

// What ./eigen status reports, read-only: the command line changes these, not this page.
export function ServerStatusSection() {
    const { data: status } = useServerStatus();

    if (!status) return null;

    const version = [status.version, status.commit, status.builtAt && formatDate(status.builtAt)].filter(Boolean);

    return (
        <>
            <SettingsSection title="Server">
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">Version</dt>
                    <dd>{version.join(' · ')}</dd>
                    <dt className="text-muted-foreground">Mail</dt>
                    <dd>
                        {status.mailEnabled
                            ? 'Mailboxes on this server'
                            : status.relayHost
                              ? `No mailboxes; mail goes out through ${status.relayHost}`
                              : 'No mailboxes and no relay: this server sends no email. Run ./eigen setup to name one.'}
                    </dd>
                    <dt className="text-muted-foreground">Disk</dt>
                    <dd>
                        {formatFileSize(status.diskFree, 1)} free of {formatFileSize(status.diskTotal, 1)}
                    </dd>
                    <dt className="text-muted-foreground">Certificate</dt>
                    <dd>
                        {status.certExpiresAt
                            ? `Expires ${formatDate(status.certExpiresAt)}`
                            : 'None on this server; a web server in front of Eigen holds it'}
                    </dd>
                </dl>
            </SettingsSection>
            <Separator />
        </>
    );
}
