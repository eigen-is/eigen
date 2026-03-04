import {createFileRoute} from '@tanstack/react-router';
import {createLoginRouteOptions} from '@workspace/ui';

export const Route = createFileRoute('/login')(createLoginRouteOptions());
