// A Support section's page: the section's articles, and those other sections list here too. It names the section in
// the browser tab, and an unknown section shows the null vector.

import { createFileRoute, useParams } from '@tanstack/react-router';
import { ErrorState, useLayout } from '@workspace/ui/components/layout/app';
import { useEffect } from 'react';
import { SitePage } from '../components/site-page';
import { getSection } from '../components/support/sections';
import { SupportSection } from '../components/support/support-section';
import { getSupportArticles } from '../content/manifest';

export const Route = createFileRoute('/support/$section/')({
    component: SectionComponent,
    head: ({ params }) => {
        const section = getSection(params.section);
        return { meta: [{ title: `${section?.title ?? params.section} - Eigen Support` }] };
    },
});

function SectionComponent() {
    const { section } = useParams({ from: '/support/$section/' });
    const config = getSection(section);
    const { setDocumentTitle } = useLayout();

    useEffect(() => {
        setDocumentTitle(config?.title ?? '');
        return () => setDocumentTitle('');
    }, [config?.title, setDocumentTitle]);

    if (!config) {
        return (
            <SitePage>
                <ErrorState />
            </SitePage>
        );
    }

    const articles = getSupportArticles().filter((a) => a.section === section || a.crossSections.includes(section));
    return <SupportSection section={config} articles={articles} />;
}
