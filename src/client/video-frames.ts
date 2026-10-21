/**
 * Browser-side video frame extraction.
 *
 * Samples a handful of still JPEG frames out of an uploaded video using only
 * `<video>` + `<canvas>` (no native decoder, no worker), so the multimodal
 * script parser can "watch" the material. Frames come back as JPEG data URLs
 * (compact enough to POST as JSON). Everything runs off a transient
 * `createObjectURL` that is always revoked — the source File is never copied.
 */

/** Default frames sampled per video when the caller does not choose a count. */
export const DEFAULT_FRAME_COUNT = 6

/** Clamp a requested frame count into a sane per-video range. */
function clampCount(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return DEFAULT_FRAME_COUNT
  return Math.min(12, Math.max(1, Math.round(count)))
}

/** Encode one video position onto a JPEG data URL via an offscreen canvas. */
function drawFrame(video: HTMLVideoElement, width: number, height: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) return ''
  ctx.drawImage(video, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', 0.72)
}

/** Wait for one `seeked` event (or timeout so a stuck decoder never hangs). */
function onceSeeked(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      window.clearTimeout(timer)
      resolve()
    }
    const onSeeked = (): void => { done() }
    const onError = (): void => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      window.clearTimeout(timer)
      reject(new Error('video decode failed'))
    }
    const timer = window.setTimeout(done, timeoutMs)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
  })
}

/**
 * Extract up to `count` evenly-spaced JPEG frames from one video file.
 *
 * The first frame is always skipped a hair (t≈0 is often black) and the last
 * lands just short of the duration. Returns JPEG data URLs in time order; a
 * frame that fails to encode is silently dropped. Empty result on any decode
 * failure — callers treat that as "this video contributed no frames".
 */
export async function extractFrames(file: File, count = DEFAULT_FRAME_COUNT): Promise<string[]> {
  const target = clampCount(count)
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'

  try {
    await new Promise<void>((resolve, reject) => {
      const onLoaded = (): void => { resolve() }
      const onError = (): void => { reject(new Error('video load failed')) }
      video.addEventListener('loadeddata', onLoaded, { once: true })
      video.addEventListener('error', onError, { once: true })
      video.load()
    })

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
    if (duration === 0) return []

    const sourceWidth = video.videoWidth || 640
    const sourceHeight = video.videoHeight || 360
    // Cap the long edge so data URLs stay small enough to POST.
    const maxEdge = 640
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(2, Math.round(sourceWidth * scale))
    const height = Math.max(2, Math.round(sourceHeight * scale))

    const frames: string[] = []
    for (let i = 0; i < target; i += 1) {
      // Spread samples across [5%, 95%] of the timeline to skip fades/blacks.
      const ratio = target === 1 ? 0.5 : (i / (target - 1)) * 0.9 + 0.05
      const time = Math.min(Math.max(ratio * duration, 0), Math.max(duration - 0.05, 0))
      try {
        video.currentTime = time
        await onceSeeked(video, 3000)
        const dataUrl = drawFrame(video, width, height)
        if (dataUrl !== '') frames.push(dataUrl)
      } catch {
        // A single bad seek must not abandon the whole video.
      }
    }
    return frames
  } catch {
    return []
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}
