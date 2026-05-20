import { Link } from '@tanstack/react-router';
import { Card, CardContent } from '@workspace/ui/components/card';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { SECTIONS } from './sections';

// The help center front door: a hero and a browse-by-topic grid. No sidebar here.
export function SupportLanding() {
    return (
        <ColumnLayout>
            <Column id="landing" width="flex">
                <div className="h-full overflow-y-auto">
                    <div className="mx-auto max-w-4xl px-6 py-12">
                        <h1 className="text-3xl font-bold text-app text-center mb-10">How can we help?</h1>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
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
                                                className="block p-3 md:p-4"
                                            >
                                                <div className="flex items-center gap-2 md:gap-3">
                                                    <div className="p-2 rounded-md" style={{ color: section.color }}>
                                                        <Icon className="w-5 h-5 md:w-6 md:h-6" />
                                                    </div>
                                                    <div>
                                                        <h3
                                                            className="font-medium text-sm md:text-base"
                                                            style={{ color: section.color }}
                                                        >
                                                            {section.title}
                                                        </h3>
                                                        <p className="text-xs text-muted-foreground hidden md:block">
                                                            {section.description}
                                                        </p>
                                                    </div>
                                                </div>
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
