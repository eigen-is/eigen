import { useParams } from '@tanstack/react-router';
import { SidebarHeader } from '@workspace/ui/components/layout/sidebar/sidebar-header';
import { SidebarItem } from '@workspace/ui/components/layout/sidebar/sidebar-item';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { FileText } from 'lucide-react';
import { getSupportArticles } from '../../content/manifest';
import { getSection } from './sections';

type SupportSidebarProps = { condensed?: boolean; onClose?: () => void; isMobile?: boolean };

// The help center's sidebar — shown only on article pages, listing the current section's articles.
export function SupportSidebar({ condensed = false, onClose, isMobile = false }: SupportSidebarProps) {
    // Non-strict: works on any route inside /support, section and article are both optional.
    const { section } = useParams({ strict: false });

    if (!section) return <div className="flex h-full flex-col" />;

    const articles = getSupportArticles()
        .filter((a) => a.section === section)
        .sort((a, b) => a.order - b.order);
    const sectionTitle = getSection(section)?.title;

    return (
        <div className="flex h-full flex-col">
            {isMobile && <SidebarHeader appName="support" onClose={onClose} />}
            <SidebarSection condensed={condensed} title={sectionTitle}>
                {articles.map((article) => {
                    const file = article.slug.split('/')[1];
                    return (
                        <SidebarItem
                            key={article.slug}
                            icon={<FileText className="h-4 w-4" />}
                            label={article.title}
                            condensed={condensed}
                            to="/support/$section/$article"
                            params={{ section, article: file }}
                        />
                    );
                })}
            </SidebarSection>
        </div>
    );
}
