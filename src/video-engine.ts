/**
 * Seedance / 即梦 video engine: a thin, framework-free proxy over the Volcano
 * Ark asynchronous `contents/generations/tasks` API. One shot is submitted, the
 * returned task id is polled until it yields a `content.video_url`, and that
 * URL is downloaded back as bytes so the browser never has to reach the
 * upstream (no CORS, no key exposure).
 *
 * The helpers here mirror engine.ts's proven timeouts, backoff, and the
 * "forward the key only to the API origin / never to a presigned URL" policy,
 * but kept isolated so the video seam can move at its own (much longer) budget.
 */

import type { VideoShotMode } from './protocol.ts'

/** A video-generation failure with a user-presentable message + stable code. */
export class VideoGenError extends Error {
  /** Stable wire code. */
  readonly code: string

  constructor(message: string, code = 'video-failed') {
    super(message)
    this.name = 'VideoGenError'
    this.code = code
  }
}

/** Upstream Ark video endpoint (secrets are host-only, never reach the client). */
export interface VideoUpstreamConfig {
  /** API root, e.g. https://ark.cn-beijing.volces.com/api/v3 */
  apiUrl: string
  /** Bearer key. Empty means the user has not configured it yet. */
  apiKey: string
  /** Seedance model id (e.g. doubao-seedance-1-0-pro-250528). */
  model: string
  /** Per-request connect timeout in ms. */
  timeoutMs: number
}

/** Everything the engine needs to shape one shot's submit request. */
export interface SeedanceShotSpec {
  /** Motion/scene prompt. */
  prompt: string
  /** Public reference URLs (frames / stills / clips). */
  referenceUrls: string[]
  /** Clip duration in seconds. */
  duration: number
  /** Aspect ratio, e.g. '16:9'. */
  ratio: string
  /** Resolution tier, e.g. '720p'. */
  resolution: string
  /** Whether to synthesize an audio track. */
  generateAudio: boolean
  /** Whether to add a watermark. */
  watermark: boolean
  /** Derived mode (text / image / video) from the references. */
  mode: VideoShotMode
}

/** Lifecycle reported by the Ark task endpoint. */
export type SeedanceTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired'

/** Budget for the submit call (a POST that only enqueues). */
const SUBMIT_TIMEOUT_MS = 60_000

/** Total polling budget for one shot; Seedance renders are slow, so this is long. */
const POLL_MAX_MS = 900_000

/** Per-request budget while polling one status snapshot. */
const POLL_REQUEST_TIMEOUT_MS = 30_000

/** Budget for downloading one finished clip URL. */
const VIDEO_FETCH_TIMEOUT_MS = 180_000

/** File extensions that mark a reference URL as a video (else treated as image). */
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi'])

/**
 * One request-scoped timeout cleared as soon as its fetch settles. Kept local
 * so a long-lived queue never leaves idle Node timers holding the process.
 */
function requestSignal(source: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abortFromSource = () => { controller.abort(source?.reason) }
  if (source?.aborted === true) abortFromSource()
  else source?.addEventListener('abort', abortFromSource, { once: true })
  const timeout = setTimeout(() => { controller.abort(new DOMException('The operation timed out.', 'TimeoutError')) }, timeoutMs)
  timeout.unref()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      source?.removeEventListener('abort', abortFromSource)
    },
  }
}

/** Whether an error came from a requestSignal budget timeout. */
function isBudgetTimeout(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'TimeoutError'
}

/** Wait between polls, but wake immediately when cancelled. */
function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    const done = () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Whether a URL carries cloud-storage signing credentials (never forward the key). */
function isPresignedUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const params = new Set(Array.from(url.searchParams.keys(), key => key.toLowerCase()))
  if (params.has('x-goog-signature') || params.has('x-goog-credential')) return true
  if (params.has('x-amz-signature') || params.has('x-amz-credential')) return true
  return params.has('signature') && (
    params.has('expires') || params.has('googleaccessid') || params.has('awsaccesskeyid')
  )
}

/** Whether a URL lives on the same origin as the API base (the only key target). */
function isSameOriginAsApi(value: string, apiUrl: string): boolean {
  try {
    return new URL(value).origin === new URL(apiUrl).origin
  } catch {
    return false
  }
}

/** Build the task-create URL from the configured API root. */
function taskCreateUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, '')
  if (/\/contents\/generations\/tasks$/.test(trimmed)) return trimmed
  return `${trimmed}/contents/generations/tasks`
}

/** Build the task-get URL for one task id. */
function taskGetUrl(apiUrl: string, taskId: string): string {
  const create = taskCreateUrl(apiUrl)
  return `${create}/${encodeURIComponent(taskId)}`
}

/** Classify a reference URL as video vs image by its path extension. */
function isVideoUrl(value: string): boolean {
  try {
    const ext = new URL(value).pathname.split('.').pop()?.toLowerCase() ?? ''
    return VIDEO_EXTENSIONS.has(ext)
  } catch {
    return Array.from(VIDEO_EXTENSIONS).some(extension => value.toLowerCase().includes(`.${extension}`))
  }
}

/** Derive the shot mode from its references (empty → text, video → video, else image). */
export function deriveShotMode(referenceUrls: string[]): VideoShotMode {
  if (referenceUrls.length === 0) return 'text'
  if (referenceUrls.some(isVideoUrl)) return 'video'
  return 'image'
}

/** Assemble the Ark `content[]` array for one shot (text + typed references). */
function buildContent(spec: SeedanceShotSpec): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = []
  if (spec.prompt.trim() !== '') content.push({ type: 'text', text: spec.prompt })
  // The first still is the opening frame; later stills are loose references.
  // Video references always become reference_video source material.
  let firstFrameUsed = false
  for (const url of spec.referenceUrls) {
    if (url.trim() === '') continue
    if (isVideoUrl(url)) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
      continue
    }
    const role = firstFrameUsed ? 'reference_image' : 'first_frame'
    firstFrameUsed = true
    content.push({ type: 'image_url', image_url: { url }, role })
  }
  return content
}

/** Reject early with an actionable message when the key is not configured. */
function requireKey(upstream: VideoUpstreamConfig): void {
  if (upstream.apiKey.trim() === '') {
    throw new VideoGenError('尚未配置视频生成的 API Key，请在设置中填写。', 'video-key-missing')
  }
}

/**
 * Submit one shot to Ark and return the task id. The request body follows the
 * documented Seedance `content[]` shape plus top-level generation knobs.
 */
export async function submitSeedanceTask(
  upstream: VideoUpstreamConfig,
  spec: SeedanceShotSpec,
  signal?: AbortSignal,
): Promise<string> {
  requireKey(upstream)
  const budget = requestSignal(signal, Math.min(SUBMIT_TIMEOUT_MS, upstream.timeoutMs))
  try {
    let response: Response
    try {
      response = await fetch(taskCreateUrl(upstream.apiUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${upstream.apiKey.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: upstream.model,
          content: buildContent(spec),
          ratio: spec.ratio,
          resolution: spec.resolution,
          duration: spec.duration,
          generate_audio: spec.generateAudio,
          watermark: spec.watermark,
        }),
        signal: budget.signal,
      })
    } catch (error) {
      if (signal?.aborted === true) throw new VideoGenError('任务已取消', 'cancelled')
      if (isBudgetTimeout(error)) throw new VideoGenError('视频任务提交超时', 'upstream-timeout')
      throw new VideoGenError(`无法提交视频任务：${error instanceof Error ? error.message : String(error)}`, 'upstream-unreachable')
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      if (isBudgetTimeout(error)) throw new VideoGenError('视频任务提交超时', 'upstream-timeout')
      throw new VideoGenError(`视频任务接口返回了非 JSON 响应（HTTP ${response.status}）`, 'upstream-invalid')
    }
    const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    if (!response.ok) {
      throw new VideoGenError(videoErrorMessage(record, `视频任务提交失败（HTTP ${response.status}）`), 'upstream-rejected')
    }
    const id = typeof record.id === 'string' ? record.id : typeof record.task_id === 'string' ? record.task_id : ''
    if (id === '') throw new VideoGenError('视频任务提交成功但未返回任务 id', 'upstream-empty')
    return id
  } finally {
    budget.dispose()
  }
}

/** Normalize the many status spellings Ark / gateways return into one enum. */
function normalizeStatus(value: unknown): SeedanceTaskStatus {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['succeeded', 'success', 'completed', 'done', 'finished'].includes(status)) return 'succeeded'
  if (['failed', 'error'].includes(status)) return 'failed'
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled'
  if (['expired', 'timeout', 'timed_out'].includes(status)) return 'expired'
  if (['running', 'processing', 'in_progress', 'generating'].includes(status)) return 'running'
  return 'queued'
}

/** Extract the finished video URL from a task payload (content.video_url or videourl). */
function extractVideoUrl(payload: Record<string, unknown>): string | undefined {
  const content = payload.content
  if (typeof content === 'string' && content.startsWith('http')) return content
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    const url = (content as Record<string, unknown>).video_url
    if (typeof url === 'string' && url !== '') return url
  }
  for (const key of ['videourl', 'video_url', 'url']) {
    const value = payload[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const output = payload.output
  if (output !== null && typeof output === 'object') {
    const nested = extractVideoUrl(output as Record<string, unknown>)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** Read an error message from the common Ark nested error locations. */
function videoErrorMessage(payload: Record<string, unknown>, fallback: string): string {
  const error = payload.error
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim() !== '') return message
  }
  if (typeof error === 'string' && error.trim() !== '') return error
  const message = payload.message
  if (typeof message === 'string' && message.trim() !== '') return message
  return fallback
}

/**
 * Poll one Ark task until it reaches a terminal state. Backoff matches
 * engine.ts (doubling, capped) but over a much longer deadline.
 */
export async function pollSeedanceTask(
  upstream: VideoUpstreamConfig,
  taskId: string,
  signal?: AbortSignal,
): Promise<{ status: SeedanceTaskStatus; videoUrl?: string; error?: string }> {
  requireKey(upstream)
  const deadline = Date.now() + Math.min(POLL_MAX_MS, upstream.timeoutMs)
  let delay = 2000
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const budget = requestSignal(signal, Math.min(POLL_REQUEST_TIMEOUT_MS, remaining))
    try {
      let response: Response
      try {
        response = await fetch(taskGetUrl(upstream.apiUrl, taskId), {
          method: 'GET',
          headers: { authorization: `Bearer ${upstream.apiKey.trim()}` },
          signal: budget.signal,
        })
      } catch (error) {
        if (signal?.aborted === true) throw new VideoGenError('任务已取消', 'cancelled')
        if (isBudgetTimeout(error)) throw new VideoGenError('视频任务轮询超时', 'upstream-timeout')
        throw new VideoGenError(`无法轮询视频任务：${error instanceof Error ? error.message : String(error)}`, 'upstream-unreachable')
      }
      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        if (isBudgetTimeout(error)) throw new VideoGenError('视频任务轮询超时', 'upstream-timeout')
        throw new VideoGenError(`视频任务接口返回了非 JSON 响应（HTTP ${response.status}）`, 'upstream-invalid')
      }
      const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      if (!response.ok) {
        throw new VideoGenError(videoErrorMessage(record, `视频任务轮询失败（HTTP ${response.status}）`), 'upstream-rejected')
      }
      const status = normalizeStatus(record.status)
      if (status === 'succeeded') {
        const videoUrl = extractVideoUrl(record)
        if (videoUrl === undefined) throw new VideoGenError('视频任务完成但未返回视频地址', 'upstream-empty')
        return { status, videoUrl }
      }
      if (status === 'failed') return { status, error: videoErrorMessage(record, '上游视频任务失败') }
      if (status === 'cancelled') return { status, error: '上游视频任务已取消' }
      if (status === 'expired') return { status, error: '上游视频任务已过期' }
    } finally {
      budget.dispose()
    }
    await waitForPoll(Math.min(delay, Math.max(1, deadline - Date.now())), signal)
    delay = Math.min(10_000, delay + 1000)
  }
  throw new VideoGenError('视频任务轮询超时', 'upstream-timeout')
}

/**
 * Download one finished clip URL as bytes. The key is forwarded only to the
 * API's own origin and never to a presigned URL, matching engine.ts's policy.
 */
export async function downloadVideo(
  url: string,
  upstream: VideoUpstreamConfig,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (url.startsWith('data:')) {
    const match = /^data:[^,]*;base64,(.*)$/s.exec(url.trim())
    if (match === null || match[1] === undefined) throw new VideoGenError('视频返回了无效的 data URL', 'upstream-invalid')
    return Buffer.from(match[1], 'base64')
  }
  const budget = requestSignal(signal, Math.min(VIDEO_FETCH_TIMEOUT_MS, upstream.timeoutMs))
  try {
    let response: Response
    try {
      const forwardKey = upstream.apiKey !== ''
        && !isPresignedUrl(url)
        && isSameOriginAsApi(url, upstream.apiUrl)
      response = await fetch(url, {
        ...forwardKey ? { headers: { authorization: `Bearer ${upstream.apiKey.trim()}` } } : {},
        signal: budget.signal,
      })
    } catch (error) {
      if (signal?.aborted === true) throw new VideoGenError('任务已取消', 'cancelled')
      if (isBudgetTimeout(error)) throw new VideoGenError('视频下载超时', 'upstream-timeout')
      throw new VideoGenError(`下载视频失败：${error instanceof Error ? error.message : String(error)}`, 'upstream-unreachable')
    }
    if (!response.ok) throw new VideoGenError(`下载视频失败：HTTP ${response.status}`, 'upstream-rejected')
    // Budget stays armed through the body read so a stalled download cannot hang.
    return Buffer.from(await response.arrayBuffer())
  } finally {
    budget.dispose()
  }
}
