import { createFileRoute } from '@tanstack/react-router';
import { createAuthRouteOptions } from '@workspace/ui/components/layout/pages';

export const Route = createFileRoute('/_auth')(createAuthRouteOptions());
