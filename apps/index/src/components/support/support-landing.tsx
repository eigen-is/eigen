// The help center's front door: the question, a search box and one grid of tiles, one for each section. It spans
// the site's wide container and has no sidebar.

import { Link } from '@tanstack/react-router';
import { KetTile } from '@workspace/ui/components/braket';
import { SitePage } from '../site-page';
import { SECTIONS } from './sections';
import { SupportSearch } from './support-search';

export function SupportLanding() {
    return (
        <SitePage>
            <div className="site-wide py-12">
                <h1 className="site-title">How can we help?</h1>
                <div className="mt-6">
                    <SupportSearch />
                </div>
                <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3">
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
        </SitePage>
    );
}
