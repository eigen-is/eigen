import { apps } from '@workspace/lib/apps';
import type { Command } from '@workspace/lib/types/command-palette';
import { BASE_RANKS } from './base-ranks';

// One "Go to <App>" command per entry in the shared apps registry — same icon, same
// landing URL the AppSwitcher uses. Don't hand-build URLs or pick fresh icons here:
// the apps array is the single source of truth.
export const navCommands: Command[] = apps.map((app) => ({
    id: `nav.${app.name.toLowerCase()}`,
    title: `Go to ${app.name}`,
    keywords: [app.description.toLowerCase()],
    icon: app.icon,
    baseRank: BASE_RANKS.NAV_APP,
    run: (ctx) => ctx.navigate(app.href),
}));
