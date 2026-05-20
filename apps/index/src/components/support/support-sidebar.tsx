import { SidebarHeader } from '@workspace/ui/components/layout/sidebar/sidebar-header';
import { SidebarItem } from '@workspace/ui/components/layout/sidebar/sidebar-item';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { SECTIONS } from './sections';

type SupportSidebarProps = { condensed?: boolean; onClose?: () => void; isMobile?: boolean };

// The help center's left navigation — one item per section. Composed from the
// shared sidebar components, exactly like SpaceSidebar.
export function SupportSidebar({ condensed = false, onClose, isMobile = false }: SupportSidebarProps) {
    return (
        <div className="flex h-full flex-col">
            {isMobile && <SidebarHeader appName="support" onClose={onClose} />}
            <SidebarSection condensed={condensed}>
                {SECTIONS.map((section) => {
                    const Icon = section.icon;
                    return (
                        <SidebarItem
                            key={section.id}
                            icon={<Icon className="h-4 w-4" />}
                            label={section.title}
                            condensed={condensed}
                            to="/support/$section"
                            params={{ section: section.id }}
                        />
                    );
                })}
            </SidebarSection>
        </div>
    );
}
