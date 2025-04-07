import { createFileRoute } from '@tanstack/react-router'
import { CollaborativeEditor } from '@/components/docs/editor'

export const Route = createFileRoute('/_auth/')({
  component: CollaborativeTextEditor,
})


function CollaborativeTextEditor() {
  return (
    <div className="container mx-auto p-4">
      <CollaborativeEditor />
    </div>
  )
}
