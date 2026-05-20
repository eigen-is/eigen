import { Link } from '@tanstack/react-router';
import { Card, CardContent } from '@workspace/ui/components/card';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import { useEffect } from 'react';
import { SECTIONS } from './sections';

// The help center front door: a hero and a browse-by-topic grid. No sidebar here.
export function SupportLanding() {
    const { setSidebarHidden } = useLayout();
    useEffect(() => {
        setSidebarHidden(true);
        return () => setSidebarHidden(false);
    }, [setSidebarHidden]);

    return (
        <ColumnLayout>
            <Column id="landing" width="flex">
                <div className="h-full overflow-y-auto">
                    <div className="mx-auto max-w-4xl px-6 py-12">
                        <h1 className="text-3xl font-bold text-center mb-10">How can we help?</h1>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-4">
                            {SECTIONS.map((section) => {
                                const Icon = section.icon;
                                return (
                                    <Card
                                        key={section.id}
                                        className="overflow-hidden hover:shadow-md transition-shadow"
                                    >
                                        <CardContent className="p-0">
                                            <Link
                                                to="/support/$section"
                                                params={{ section: section.id }}
                                                className="block p-4"
                                            >
                                                <Icon className="h-6 w-6" style={{ color: section.color }} />
                                                <h3 className="font-medium mt-2">{section.title}</h3>
                                                <p className="text-sm text-muted-foreground">{section.description}</p>
                                            </Link>
                                        </CardContent>
                                    </Card>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
