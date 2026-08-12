import { createFileRoute } from '@tanstack/react-router';
import { createAuthRouteOptions } from '@workspace/ui/components/layout/pages/auth-route.tsx';

export const Route = createFileRoute('/_auth')(createAuthRouteOptions({ redirectGuests: true }));
