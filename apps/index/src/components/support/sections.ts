import { apps } from '@workspace/lib/apps';
import { type LucideIcon, MonitorSmartphone, Rocket, Settings, Shield } from 'lucide-react';

export type SectionConfig = {
    id: string;
    title: string;
    description: string;
    icon: LucideIcon;
    color: string;
};

// App-backed sections take their icon and brand colour from the shared app
// registry, so the help center stays in sync with the rest of Eigen.
const appsByName = new Map(apps.map((a) => [a.name, a]));
function app(name: string): Pick<SectionConfig, 'icon' | 'color'> {
    const entry = appsByName.get(name);
    if (!entry) throw new Error(`Help section references unknown app: ${name}`);
    return { icon: entry.icon, color: entry.color };
}

// Sections without their own app take the index app's own colour — the greenish
// brand used by the help center header and callouts (var(--app-current-color)).
const INDEX = 'var(--app-current-color)';

// Display order, titles, icons, and colours for help center sections. The `id`
// matches the folder name under src/data/support/.
export const SECTIONS: SectionConfig[] = [
    {
        id: 'getting-started',
        title: 'Getting started',
        description: 'New to Eigen — start here.',
        icon: Rocket,
        color: INDEX,
    },
    { id: 'mail', title: 'Mail', description: 'Reading, composing, filters.', ...app('Mail') },
    { id: 'drive', title: 'Drive', description: 'Files, folders, sharing.', ...app('Drive') },
    { id: 'docs', title: 'Docs', description: 'Editing and collaboration.', ...app('Docs') },
    { id: 'sheets', title: 'Sheets', description: 'Spreadsheets and formulas.', ...app('Sheets') },
    { id: 'slides', title: 'Slides', description: 'Building and presenting decks.', ...app('Slides') },
    { id: 'calendar', title: 'Calendar', description: 'Events, invites, sharing.', ...app('Calendar') },
    { id: 'contacts', title: 'Contacts', description: 'Managing people and groups.', ...app('Contacts') },
    { id: 'chat', title: 'Chat', description: 'Messages and spaces.', ...app('Chat') },
    { id: 'stickies', title: 'Stickies', description: 'Notes and boards.', ...app('Stickies') },
    {
        id: 'connect',
        title: 'Integrations',
        description: 'Use Eigen with other apps.',
        icon: MonitorSmartphone,
        color: INDEX,
    },
    {
        id: 'account',
        title: 'Account & settings',
        description: 'Profile, security, appearance.',
        icon: Settings,
        color: INDEX,
    },
    {
        id: 'admin',
        title: 'Admin',
        description: 'Organisations, teams, the server.',
        icon: Shield,
        color: INDEX,
    },
];

const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

export function getSection(id: string): SectionConfig | undefined {
    return BY_ID.get(id);
}
