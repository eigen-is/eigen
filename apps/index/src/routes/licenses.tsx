import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import type { LicensePackage } from '../../scripts/lib/content-types';

// Eager glob (not a static import) so a not-yet-generated file degrades to an empty list
// in dev instead of breaking the module load. Regenerated on every prod build by
// scripts/build-licenses.ts (prebuild).
const generated = import.meta.glob<{ packages: LicensePackage[] }>('../content/.generated/licenses.json', {
    eager: true,
    import: 'default',
});
const packages: LicensePackage[] = Object.values(generated)[0]?.packages ?? [];

export const Route = createFileRoute('/licenses')({
    component: LicensesPage,
    head: () => ({
        meta: [
            { title: 'Open-source licenses - eigen' },
            { name: 'description', content: 'The open-source packages eigen is built on, and their licenses.' },
            { property: 'og:title', content: 'Open-source licenses - eigen' },
            {
                property: 'og:description',
                content: 'The open-source packages eigen is built on, and their licenses.',
            },
            { property: 'og:type', content: 'website' },
        ],
    }),
});

function LicensesPage() {
    return (
        <AppShell appName="licenses" rootRoute={Route}>
            <ColumnLayout>
                <Column id="licenses" width="flex">
                    <div className="h-full overflow-y-auto">
                        <div className="mx-auto w-full max-w-[80ch] px-6 py-10">
                            <h1 className="text-2xl font-medium mb-2">Open-source licenses</h1>
                            <p className="text-foreground leading-7 mb-8">
                                eigen is built on the work of {packages.length} open-source packages. Thank you to
                                everyone who maintains them.
                            </p>
                            <ul className="divide-y divide-border">
                                {packages.map((pkg) => (
                                    <li key={pkg.name} className="flex items-baseline gap-3 py-2 text-sm">
                                        <a
                                            href={pkg.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-link hover:text-link/80 font-medium"
                                        >
                                            {pkg.name}
                                        </a>
                                        <span className="text-muted-foreground tabular-nums">{pkg.version}</span>
                                        <span className="ml-auto text-muted-foreground">{pkg.license}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </Column>
            </ColumnLayout>
        </AppShell>
    );
}
