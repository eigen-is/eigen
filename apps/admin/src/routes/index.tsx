import { createFileRoute, redirect } from '@tanstack/react-router'
import { checkSetupRequired } from '@workspace/lib/admin'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const setupStatus = await checkSetupRequired()
    if (setupStatus?.setupRequired) {
      throw redirect({ to: '/setup' })
    }
    throw redirect({ to: '/dashboard' })
  },
})
