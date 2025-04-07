import { useEffect, useMemo, useState } from 'react'
import { createEditor, Editor, Transforms } from 'slate'
import { Editable, Slate, withReact } from 'slate-react'
import { withCursors, withYjs, YjsEditor } from '@slate-yjs/core'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { Cursors } from './cursors'
import { useAuth } from '@workspace/lib/auth/auth-context.js'

const initialValue = [
    {
      type: 'paragraph',
      children: [{ text: 'Type something...' }],
    },
  ]

export const CollaborativeEditor = () => {
  const [connected, setConnected] = useState(false)
  const [sharedType, setSharedType] = useState<Y.XmlText | null>(null)
  const [provider, setProvider] = useState<WebsocketProvider | null>(null)

  // Connect to your Yjs provider and document
  useEffect(() => {
    const yDoc = new Y.Doc()
    const sharedDoc = yDoc.get('slate', Y.XmlText)

    // Build WebSocket URL
    const wsUrl = `${import.meta.env.VITE_API_HOST}/ws/collab/userid/`
    const documentId = 'foo'

    // Create WebSocket provider
    const provider = new WebsocketProvider(wsUrl, documentId, yDoc, {
    resyncInterval: 5000,
    connect: true,
    })

    // Set up your Yjs provider. This line of code is different for each provider.
    const yProvider = provider;

    yProvider.on('sync', setConnected);
    setSharedType(sharedDoc);
    setProvider(provider);

    return () => {
      yDoc?.destroy()
      yProvider?.off('sync', setConnected)
      yProvider?.destroy()
    }
  }, [])

  if (!connected || !sharedType || !provider) {
    return <div>Loading…</div>
  }

  return <SlateEditor sharedType={sharedType} provider={provider} />
}

const SlateEditor = ({ sharedType, provider }: { sharedType: Y.XmlText | null; provider: WebsocketProvider | null }) => {
  const auth = useAuth();

  const editor = useMemo(() => {
    const e = withReact(withCursors(withYjs(createEditor(), sharedType!), provider!.awareness, {
      // The current user's name and color
      data: {
        name: auth.user?.name,
        email: auth.user?.email,
        color: '#660044',
      },
    }));

    // Ensure editor always has at least 1 valid child
    const { normalizeNode } = e
    e.normalizeNode = entry => {
      const [node] = entry

      if (!Editor.isEditor(node) || node.children.length > 0) {
        return normalizeNode(entry)
      }

      Transforms.insertNodes(e, initialValue, { at: [0] })
    }

    return e
  }, [])

  useEffect(() => {
    YjsEditor.connect(editor)
    return () => YjsEditor.disconnect(editor)
  }, [editor])

  return (
    <Slate editor={editor} initialValue={initialValue}>
      <Cursors>
        <Editable />
      </Cursors>
    </Slate>
  )
}