import { createFileRoute } from '@tanstack/react-router';
import { getSupportUrl } from '@workspace/lib/api';
import { apps } from '@workspace/lib/apps';
import { Column, ColumnLayout, EigenCyclingLogo, KetTile } from '@workspace/ui';
import { LifeBuoy } from 'lucide-react';

export const Route = createFileRoute('/_auth/')({
    component: HomeComponent,
});

function HomeComponent() {
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
                                <KetTile
                                    icon={LifeBuoy}
                                    title="Help and support"
                                    description="Find answers and guides"
                                    color="var(--muted-foreground)"
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
