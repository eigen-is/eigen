import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { useAuth } from '@workspace/lib/auth/auth-context.tsx'

export const Route = createFileRoute('/_auth')({
  beforeLoad: ({context, location}) => {
    if (!context.auth.isAuthenticated) {
      throw redirect({
        to: '/login',
        search: {
          redirect: location.href,
        },
      })
    }
  },
  component: AuthLayout,
})

function AuthLayout() {
  return (
    <Outlet />
  )
}