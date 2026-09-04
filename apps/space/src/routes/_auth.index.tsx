import { createFileRoute } from '@tanstack/react-router';
import { apps } from '@workspace/lib/apps';
import { Column, ColumnLayout, EigenCyclingLogo } from '@workspace/ui';
import { Card, CardContent } from '@workspace/ui/components/card';

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
                                    const Icon = app.icon;
                                    return (
                                        <Card
                                            key={app.name}
                                            className="overflow-hidden hover:shadow-md transition-shadow"
                                        >
                                            <CardContent className="p-0">
                                                <a href={app.href || '#'} className="block p-3 md:p-4">
                                                    <div className="flex items-center gap-2 md:gap-3">
                                                        <div className="p-2 rounded-md" style={{ color: app.color }}>
                                                            <Icon className="w-5 h-5 md:w-6 md:h-6" />
                                                        </div>
                                                        <div>
                                                            <h3
                                                                className="font-medium text-sm md:text-base"
                                                                style={{ color: app.color }}
                                                            >
                                                                {app.name}
                                                            </h3>
                                                            <p className="text-xs text-muted-foreground hidden md:block">
                                                                {app.description}
                                                            </p>
                                                        </div>
                                                    </div>
                                                </a>
                                            </CardContent>
                                        </Card>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
