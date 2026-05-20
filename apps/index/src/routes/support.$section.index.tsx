import { createFileRoute, useParams } from '@tanstack/react-router';
import { getSection } from '../components/support/sections';
import { SupportSection } from '../components/support/support-section';
import { getSupportArticles } from '../content/manifest';

export const Route = createFileRoute('/support/$section/')({
    component: SectionComponent,
    head: ({ params }) => {
        const section = getSection(params.section);
        return { meta: [{ title: `${section?.title ?? params.section} - Eigen Help` }] };
    },
});

function SectionComponent() {
    const { section } = useParams({ from: '/support/$section/' });
    const articles = getSupportArticles().filter((a) => a.section === section || a.crossSections.includes(section));
    return <SupportSection section={section} articles={articles} />;
}
