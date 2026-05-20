import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SupportShell } from '../components/support/support-shell';

export const Route = createFileRoute('/support')({
    component: () => (
        <SupportShell>
            <Outlet />
        </SupportShell>
    ),
});
