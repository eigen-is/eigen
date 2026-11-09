// The sidebar row of Drive's Recent page, which Drive's sidebar and the other apps' sidebars, such as Chat's
// and Mail's, all draw. Inside Drive it routes to the page, and from any other app it opens the page in Drive.

import { getDriveAppUrl } from '@workspace/lib/api';
import { Clock } from 'lucide-react';
import { SidebarItem } from './sidebar-item';

export function RecentFilesSidebarItem({ condensed, inDrive = false }: { condensed: boolean; inDrive?: boolean }) {
    const target = inDrive ? { to: '/recent' } : { href: getDriveAppUrl('recent') };
    return <SidebarItem icon={<Clock className="h-4 w-4" />} {...target} label="Recent files" condensed={condensed} />;
}
