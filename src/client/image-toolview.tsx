/** Inline renderer for image-generation tool-result attachments. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Download, Maximize2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AGENT_IMAGE_API } from '../protocol.ts'
import { CHAT_IMAGE_EVENT } from './conversation-sync.ts'
import css from './image-toolview.module.css'

/** Owner props supplied by the host's keyed tool-call slot. */
export interface ImageToolViewOwnerProps {
  callId: string
  toolName: string
  block: ToolCallBlock
  cwd?: string
  home?: string
  openFile: (path: string) => void
  inspect?: () => void
}

interface LoadedImage {
  ref: ImageAttachmentRef
  src: string
}

interface ImageToolViewProps extends ImageToolViewOwnerProps {
  sessionId: SessionId
}

function isSettled(block: ToolCallBlock): block is Extract<ToolCallBlock, { kind: 'tool-result' }> {
  return 'kind' in block
}

function attachmentRefOf(value: unknown): ImageAttachmentRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const attachmentId = typeof raw.attachment_id === 'string'
    ? raw.attachment_id
    : typeof raw.attachmentId === 'string' ? raw.attachmentId : undefined
  const mediaType = typeof raw.media_type === 'string'
    ? raw.media_type
    : typeof raw.mediaType === 'string' ? raw.mediaType : undefined
  if (attachmentId === undefined
    || (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp' && mediaType !== 'image/gif')
    || typeof raw.bytes !== 'number'
    || typeof raw.width !== 'number'
    || typeof raw.height !== 'number') return undefined
  return {
    attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType,
    bytes: raw.bytes,
    width: raw.width,
    height: raw.height,
    ...typeof raw.name === 'string' ? { name: raw.name } : {},
  }
}

function imageRefsFromUnknown(value: unknown): ImageAttachmentRef[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const images = (value as { images?: unknown }).images
  if (!Array.isArray(images)) return []
  return images.flatMap(image => {
    const ref = attachmentRefOf(image)
    return ref === undefined ? [] : [ref]
  })
}

function imageRefsOf(block: ToolCallBlock): ImageAttachmentRef[] {
  if (!isSettled(block)) return []
  const refs = block.content.flatMap(content => content.type === 'image' ? [content.attachment] : [])
  // Current DSH shells persist presentation-only attachments in result meta;
  // older shells materialized them into block.content. Accept both forms.
  refs.push(...imageRefsFromUnknown((block as ToolCallBlock & { meta?: unknown }).meta))
  if (refs.length === 0) {
    try {
      refs.push(...imageRefsFromUnknown(JSON.parse(textOf(block))))
    } catch {
      // Non-JSON result text simply has no attachment fallback.
    }
  }
  return [...new Map(refs.map(ref => [String(ref.attachmentId), ref])).values()]
}

function textOf(block: ToolCallBlock): string {
  if (!isSettled(block)) return ''
  return block.content
    .filter(content => content.type === 'text')
    .map(content => content.text)
    .join('\n')
}

function resultInfo(block: ToolCallBlock): { status: string; message: string } {
  if (!isSettled(block)) return { status: 'running', message: '正在生成图片…' }
  const text = textOf(block)
  try {
    const parsed = JSON.parse(text) as { status?: unknown; message?: unknown }
    return {
      status: typeof parsed.status === 'string' ? parsed.status : block.isError ? 'failed' : 'completed',
      message: typeof parsed.message === 'string' ? parsed.message : '',
    }
  } catch {
    return { status: block.isError ? 'failed' : 'completed', message: text }
  }
}

function statusLabel(status: string): string {
  if (status === 'running' || status === 'queued') return '生成中'
  if (status === 'failed') return '生成失败'
  if (status === 'cancelled') return '已取消'
  return '图片结果'
}

function useAttachmentImages(
  sessionId: SessionId,
  refs: ImageAttachmentRef[],
  load: (sessionId: SessionId, ref: ImageAttachmentRef) => Promise<string>,
): { images: LoadedImage[]; error: string | null } {
  const key = useMemo(() => refs.map(ref => String(ref.attachmentId)).join('|'), [refs])
  const [images, setImages] = useState<LoadedImage[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    const urls: string[] = []
    const revoke = (): void => {
      for (const url of urls) URL.revokeObjectURL(url)
      urls.length = 0
    }

    setImages([])
    setError(null)
    if (refs.length === 0) return () => { /* no attachments to clean up */ }

    void Promise.all(refs.map(async ref => {
      const src = await load(sessionId, ref)
      urls.push(src)
      return { ref, src }
    }))
      .then(next => {
        if (!disposed) setImages(next)
      })
      .catch(errorValue => {
        revoke()
        if (!disposed) setError(errorValue instanceof Error ? errorValue.message : String(errorValue))
      })

    return () => {
      disposed = true
      revoke()
    }
  }, [key, load, refs, sessionId])

  return { images, error }
}

interface ImageGalleryProps {
  images: LoadedImage[]
  prominent?: boolean
}

function ImageGallery({ images, prominent = false }: ImageGalleryProps): React.JSX.Element {
  const [preview, setPreview] = useState<LoadedImage | null>(null)

  useEffect(() => {
    if (preview === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPreview(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [preview])

  return <>
    <div className={prominent ? css.turnImages : css.images}>
      {images.map(image => <div className={css.imageCard} key={String(image.ref.attachmentId)}>
        <button
          type="button"
          className={prominent ? css.turnImageButton : css.imageButton}
          onClick={() => { setPreview(image) }}
          title="点击放大"
          aria-label={`放大查看${image.ref.name ?? '生成图片'}`}
        >
          <img className={prominent ? css.turnImage : css.image} src={image.src} alt={image.ref.name ?? '生成图片'} />
          <span className={css.previewBadge} aria-hidden="true"><Maximize2 size={15} strokeWidth={1.8} /></span>
        </button>
        <a
          className={css.downloadButton}
          href={image.src}
          download={image.ref.name ?? 'generated-image.png'}
          title="下载原图"
          aria-label="下载原图"
        ><Download size={15} strokeWidth={1.8} aria-hidden="true" /></a>
      </div>)}
    </div>
    {preview !== null && typeof document !== 'undefined' ? createPortal(
      <div className={css.lightbox} role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => { setPreview(null) }}>
        <div className={css.lightboxActions} onClick={event => { event.stopPropagation() }}>
          <a className={css.lightboxDownload} href={preview.src} download={preview.ref.name ?? 'generated-image.png'}>
            <Download size={17} strokeWidth={1.8} aria-hidden="true" />
            <span>下载原图</span>
          </a>
          <button type="button" className={css.lightboxClose} title="关闭" aria-label="关闭" onClick={() => { setPreview(null) }}>
            <X size={20} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        <img
          className={css.lightboxImage}
          src={preview.src}
          alt={preview.ref.name ?? '生成图片'}
          onClick={event => { event.stopPropagation() }}
        />
      </div>,
      document.body,
    ) : null}
  </>
}

export interface ImageTurnTailOwnerProps {
  seq: number
  turn: { data: { get(key: string): unknown } }
}

interface ImageTurnTailProps extends ImageTurnTailOwnerProps {
  sessionId: SessionId
}

interface ImageTurnResult {
  seq: number
  refs: ImageAttachmentRef[]
}

interface ImageTurnData {
  results: ImageTurnResult[]
}

const IMAGE_RESULT_TOOLS = new Set(['generate_image', 'edit_image', 'get_image_generation_task'])
const IMAGE_TURN_DATA_KEY = 'dsh-imagegen-results'

function imageTurnData(value: unknown): ImageTurnData | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const results = (value as { results?: unknown }).results
  return Array.isArray(results) ? { results: results as ImageTurnResult[] } : undefined
}

function turnImageRefs(props: ImageTurnTailProps): ImageAttachmentRef[] {
  const results = imageTurnData(props.turn.data.get(IMAGE_TURN_DATA_KEY))?.results ?? []
  const refs = results.filter(result => result.seq <= props.seq).flatMap(result => result.refs)
  return [...new Map(refs.map(ref => [String(ref.attachmentId), ref])).values()]
}

const imageTurnDefinition = {
  kind: IMAGE_TURN_DATA_KEY,
  match: (event: any) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context: unknown, match: any) => ({
    turn: match.event.data.turn,
    calls: new Set<string>(),
    results: [] as ImageTurnResult[],
  }),
  update: (context: any, match: any) => {
    const event = match.event
    if (event.type === 'tool/call') {
      if (!IMAGE_RESULT_TOOLS.has(event.data.name)) return context.state
      const calls = new Set<string>(context.state.calls)
      calls.add(String(event.data.callId))
      return { ...context.state, calls }
    }
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append' || event.data.message.isError === true) return context.state
    const callId = String(event.data.message.source.callId)
    if (!context.state.calls.has(callId)) return context.state
    const refs = imageRefsFromUnknown(event.data.meta)
    return refs.length === 0 ? context.state : {
      ...context.state,
      results: [...context.state.results, { seq: event.seq, refs }],
    }
  },
  buildLocationData: (context: any, scope: string) => scope !== 'turn' || context.state === undefined
    ? null
    : {
        kind: 'turn',
        turn: context.state.turn,
        key: IMAGE_TURN_DATA_KEY,
        value: { results: context.state.results },
      },
}

/** Register the inline image result view and the always-visible turn result. */
export function registerImageToolviews(ctx: ClientContext): void {
  const load = async (_sessionId: SessionId, ref: ImageAttachmentRef): Promise<string> => {
    // Tool-result images intentionally do not occur in model-visible session
    // content, so session.readAttachment() rejects them. The plugin route
    // reads the same durable attachment after validating the complete ref.
    const query = new URLSearchParams({
      attachment_id: String(ref.attachmentId),
      media_type: ref.mediaType,
      bytes: String(ref.bytes),
      width: String(ref.width),
      height: String(ref.height),
    })
    const response = await fetch(`${AGENT_IMAGE_API}?${query.toString()}`)
    if (!response.ok) throw new Error(`无法读取图片附件（HTTP ${response.status}）。`)
    const blob = await response.blob()
    return URL.createObjectURL(blob)
  }

  const ImageToolView = (props: ImageToolViewProps): React.JSX.Element => {
    const refs = useMemo(() => imageRefsOf(props.block), [props.block])
    const { status, message } = resultInfo(props.block)
    const { images, error } = useAttachmentImages(props.sessionId, refs, load)

    useEffect(() => {
      if (images.length === 0) return
      document.dispatchEvent(new CustomEvent(CHAT_IMAGE_EVENT, {
        detail: {
          sessionId: props.sessionId,
          refs: images.map(image => image.ref),
        },
      }))
    }, [images, props.sessionId])

    return <section className={css.root} data-state={status} data-tool={props.toolName}>
      <header className={css.header}>
        <span className={css.icon} aria-hidden="true">▧</span>
        <strong>{props.toolName}</strong>
        <span className={css.status}>{statusLabel(status)}</span>
      </header>
      {message !== '' && <p className={css.message}>{message}</p>}
      {images.length > 0 && <ImageGallery images={images} />}
      {refs.length > 0 && images.length === 0 && error === null && <p className={css.loading}>正在加载图片…</p>}
      {error !== null && <p className={css.error}>{error}</p>}
    </section>
  }

  const ImageTurnTail = (props: ImageTurnTailProps): React.JSX.Element | null => {
    const refs = useMemo(() => turnImageRefs(props), [props.seq, props.turn])
    const { images, error } = useAttachmentImages(props.sessionId, refs, load)
    if (refs.length === 0) return null
    return <section className={css.turnResult} aria-label="生成图片结果">
      {images.length > 0 && <ImageGallery images={images} prominent />}
      {images.length === 0 && error === null && <p className={css.loading}>正在加载生成图片…</p>}
      {error !== null && <p className={css.error}>{error}</p>}
    </section>
  }

  const uiConversation = (ctx as ClientContext & {
    uiConversation: { events: { register(definition: unknown): void } }
  }).uiConversation
  uiConversation.events.register(imageTurnDefinition)
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: '@dickpy/dsh-imagegen:images',
    inject: (sessionId: string) => ({ sessionId: sessionId as SessionId }),
  }, ImageTurnTail))

  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of ['generate_image', 'edit_image', 'get_image_generation_task']) {
      yield ctx.slots.register({
        name: 'tool.call.toolview',
        key,
        inject: (sessionId: string) => ({ sessionId: sessionId as SessionId }),
      }, ImageToolView)
    }
  })
}
