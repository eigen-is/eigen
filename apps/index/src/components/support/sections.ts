import {
    Calendar,
    Contact,
    FileText,
    FolderOpen,
    type LucideIcon,
    Mail,
    MessageSquare,
    Plug,
    Presentation,
    Rocket,
    Settings,
    Shield,
    StickyNote,
    Table,
} from 'lucide-react';

export type SectionConfig = { id: string; title: string; description: string; icon: LucideIcon };

// Display order, titles, and icons for help center sections. The `id` matches
// the folder name under src/data/support/.
export const SECTIONS: SectionConfig[] = [
    { id: 'getting-started', title: 'Getting started', description: 'New to Eigen — start here.', icon: Rocket },
    { id: 'mail', title: 'Mail', description: 'Reading, composing, filters.', icon: Mail },
    { id: 'drive', title: 'Drive', description: 'Files, folders, sharing.', icon: FolderOpen },
    { id: 'docs', title: 'Docs', description: 'Editing and collaboration.', icon: FileText },
    { id: 'sheets', title: 'Sheets', description: 'Spreadsheets and formulas.', icon: Table },
    { id: 'slides', title: 'Slides', description: 'Building and presenting decks.', icon: Presentation },
    { id: 'calendar', title: 'Calendar', description: 'Events, invites, sharing.', icon: Calendar },
    { id: 'contacts', title: 'Contacts', description: 'Managing people and groups.', icon: Contact },
    { id: 'chat', title: 'Chat', description: 'Messages and spaces.', icon: MessageSquare },
    { id: 'stickies', title: 'Stickies', description: 'Notes and boards.', icon: StickyNote },
    { id: 'connect', title: 'Connecting external apps', description: 'Use Eigen with other apps.', icon: Plug },
    { id: 'account', title: 'Account & settings', description: 'Profile, security, appearance.', icon: Settings },
    { id: 'admin', title: 'Admin', description: 'Organisations, teams, the server.', icon: Shield },
];

const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

export function getSection(id: string): SectionConfig | undefined {
    return BY_ID.get(id);
}
