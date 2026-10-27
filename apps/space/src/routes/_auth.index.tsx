// The space index: a launcher tile for every enabled app, an Admin tile for an admin, and a tile
// for the help center. Each app tile wears its color from the app registry. The help tile wears
// Space's teal, as the help center itself does.

import { createFileRoute } from '@tanstack/react-router';
import { useIsAdmin } from '@workspace/lib/admin';
import { getSupportUrl } from '@workspace/lib/api';
import { adminApp } from '@workspace/lib/apps';
import { useEnabledApps } from '@workspace/lib/public';
import { Column, ColumnLayout, EigenCyclingLogo, KetTile } from '@workspace/ui';
import { LifeBuoy } from 'lucide-react';

export const Route = createFileRoute('/_auth/')({
    component: HomeComponent,
});

function HomeComponent() {
    const apps = useEnabledApps();
    const isAdmin = useIsAdmin();
    return (
        <ColumnLayout>
            <Column id="detail" width="flex" onBack="sidebar">
                <div className="h-full overflow-y-auto">
                    <div className="flex flex-col items-center justify-center w-full px-4 py-8">
                        <EigenCyclingLogo className="text-3xl mb-6" />

                        <div className="text-md text-center mb-10">
                            <p className="mb-4">
                                A self-hosted alternative to Google Workspace.
                                <br />
                                Simple and secure. You control your data.
                            </p>
                        </div>

                        <div className="max-w-4xl mx-auto w-full overflow-auto">
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
                                {apps.map((app) => {
                                    if (app.name === 'Space') return null;
                                    return (
                                        <KetTile
                                            key={app.name}
                                            icon={app.icon}
                                            title={app.name}
                                            description={app.description}
                                            color={app.color}
                                        >
                                            <a href={app.href || '#'} />
                                        </KetTile>
                                    );
                                })}
                                {isAdmin && (
                                    <KetTile
                                        icon={adminApp.icon}
                                        title={adminApp.name}
                                        description={adminApp.description}
                                        color={adminApp.color}
                                    >
                                        <a href={adminApp.href} />
                                    </KetTile>
                                )}
                                <KetTile
                                    icon={LifeBuoy}
                                    title="Help and support"
                                    description="Find answers and guides"
                                    color="var(--app-space-color)"
                                >
                                    <a href={getSupportUrl()} />
                                </KetTile>
                            </div>
                        </div>
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
