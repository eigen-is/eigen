import { createFileRoute } from '@tanstack/react-router';
import { apps } from '@workspace/lib/apps';
import { Card, CardContent } from '@workspace/ui/components/card';

export const Route = createFileRoute('/_auth/')({
    component: HomeComponent,
});

function HomeComponent() {
    return (
        <div className="flex flex-col h-full flex-1 overflow-y-auto">
            <div className="flex-1 flex flex-col items-center justify-center w-full px-4 py-8">
                <div className="text-4xl mb-6">
                    <span className="font-bold text-app">eigen</span>
                </div>

                <div className="text-md text-center mb-10">
                    <p className="mb-4">
                        Your personal workspace in the cloud.
                        <br />
                        Simple and secure. You control your own data.
                    </p>
                </div>

                <div className="max-w-4xl mx-auto w-full overflow-auto">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
                        {apps.map((app) => {
                            if (app.name === 'Space') return null;
                            const Icon = app.icon;
                            return (
                                <Card key={app.name} className="overflow-hidden hover:shadow-md transition-shadow">
                                    <CardContent className="p-0">
                                        <a href={app.href || '#'} className="block p-3 md:p-6">
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
    );
}
