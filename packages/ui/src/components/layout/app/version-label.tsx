// The line that says which build a server runs, such as "Version 0.4.2 · 3f2a9c1 · 2026-11-03". It reads the
// server's public config and draws nothing until that has loaded. The About dialog and the public site's footer
// both show it, each inside its own link to the changelog.

import { formatInputDate } from '@workspace/lib/date';
import { usePublicConfig } from '@workspace/lib/public';

export function VersionLabel() {
    const { data: config } = usePublicConfig();
    if (!config) return null;

    return (
        <>
            Version {config.version}
            {config.commit && (
                <>
                    {' · '}
                    {config.commit}
                    {config.builtAt && ` · ${formatInputDate(config.builtAt)}`}
                </>
            )}
        </>
    );
}
