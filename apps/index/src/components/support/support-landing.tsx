import { Link } from '@tanstack/react-router';
import { Column, ColumnLayout, KetTile } from '@workspace/ui';
import { SECTIONS } from './sections';
import { SupportSearch } from './support-search';

// The help center front door: a hero and a browse-by-topic grid. No sidebar here.
export function SupportLanding() {
    return (
        <ColumnLayout>
            <Column id="landing" width="flex">
                <div className="h-full overflow-y-auto">
                    <div className="px-4 py-12">
                        <div className="mx-auto max-w-4xl">
                            <h1 className="text-3xl font-normal text-app text-center mb-6">How can we help?</h1>
                            <div className="mb-10">
                                <SupportSearch />
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
                                {SECTIONS.map((section) => (
                                    <KetTile
                                        key={section.id}
                                        icon={section.icon}
                                        title={section.title}
                                        description={section.description}
                                        color={section.color}
                                    >
                                        <Link to="/support/$section" params={{ section: section.id }} />
                                    </KetTile>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
