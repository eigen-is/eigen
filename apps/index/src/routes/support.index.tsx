import { createFileRoute } from '@tanstack/react-router';
import { SupportLanding } from '../components/support/support-landing';

export const Route = createFileRoute('/support/')({
    component: SupportLanding,
    head: () => ({
        meta: [{ title: 'Eigen Support' }, { name: 'description', content: 'Help and documentation for Eigen.' }],
    }),
});
