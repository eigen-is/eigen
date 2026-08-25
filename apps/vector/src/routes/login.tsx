import { createFileRoute } from '@tanstack/react-router';
import { createLoginRouteOptions } from '@workspace/ui/components/layout/pages';

export const Route = createFileRoute('/login')(createLoginRouteOptions());
