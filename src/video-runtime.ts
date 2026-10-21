/**
 * Host-side video generation runtime: one submitted {@link VideoGenerateRequest}
 * becomes a whole finished cut. The runtime walks the storyboard shot by shot
 * (submit → poll → download → write clip), then concatenates the clips with a
 * local ffmpeg, persists the result through video-store, and reports coarse
 * stage + progress so the panel can drive a progress bar.
 *
 * It owns a small in-memory queue (like GenerationTaskQueue) but with a much
 * longer budget and a video-shaped task record (stage / progress / shotResults).
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import {
  deriveShotMode,
  downloadVideo,
  pollSeedanceTask,
  submitSeedanceTask,
  VideoGenError,
  type VideoUpstreamConfig,
} from './video-engine.ts'
import {
  appendVideo,
  clipRelPath,
  finalizePartialVideo,
  getPartialConcatInfo,
  recordPartialVideo,
  readVideoFile,
  stampedFinalRelPath,
  videoFilesDir,
  writeVideoFile,
} from './video-store.ts'
import { VIDEO_HISTORY_API } from './protocol.ts'
import type {
  VideoGenerateRequest,
  VideoHistoryEntry,
  VideoShotResult,
  VideoTask,
  VideoTaskStatus,
} from './protocol.ts'

/** The live settings view the runtime reads upstream credentials + ffmpeg from. */
export interface VideoRuntimeView {
  enabled: boolean
  upstream: VideoUpstreamConfig
  ffmpegPath: string
}

export type VideoTaskListener = (task: VideoTask) => void

/** How many finished-cut tasks run at once. Video renders are heavy, so 1. */
const VIDEO_CONCURRENCY = 1

/** Weight of the concat step in the overall progress, relative to one shot. */
const CONCAT_WEIGHT = 1

/** Whether a task status is terminal (no further transitions expected). */
function isTerminal(status: VideoTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export class VideoGenerationRuntime {
  private readonly tasks: VideoTask[] = []
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<VideoTaskListener>()
  private running = 0

  constructor(private readonly resolve: () => VideoRuntimeView) {}

  list(): VideoTask[] {
    return this.tasks.map(task => this.snapshot(task))
  }

  /** Active tasks plus the newest terminal ones (bounded poll payload). */
  summaries(terminalLimit = 50): VideoTask[] {
    const limit = Math.max(0, Math.floor(terminalLimit))
    const active = this.tasks.filter(task => task.status === 'queued' || task.status === 'running')
    const terminal = this.tasks.filter(task => task.status !== 'queued' && task.status !== 'running').slice(0, limit)
    const selected = new Set([...active, ...terminal].map(task => task.id))
    return this.tasks.filter(task => selected.has(task.id)).map(task => this.snapshot(task))
  }

  get(id: string): VideoTask | undefined {
    const task = this.tasks.find(item => item.id === id)
    return task === undefined ? undefined : this.snapshot(task)
  }

  subscribe(listener: VideoTaskListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  submit(request: VideoGenerateRequest): VideoTask {
    const shotResults: VideoShotResult[] = request.shots.map((shot, index) => ({
      index,
      status: 'queued',
      prompt: shot.prompt,
    }))
    const task: VideoTask = {
      id: randomUUID(),
      request: { ...request },
      status: 'queued',
      stage: 'preparing',
      progress: 0,
      shotResults,
      createdAt: Date.now(),
    }
    this.tasks.unshift(task)
    this.publish(task)
    this.drain()
    return this.snapshot(task)
  }

  cancel(id: string): VideoTask | undefined {
    const task = this.tasks.find(item => item.id === id)
    if (task === undefined || isTerminal(task.status)) return task
    task.status = 'cancelled'
    task.finishedAt = Date.now()
    this.controllers.get(id)?.abort()
    this.publish(task)
    this.drain()
    return this.snapshot(task)
  }

  retry(id: string): VideoTask | undefined {
    const previous = this.tasks.find(item => item.id === id)
    return previous === undefined ? undefined : this.submit(previous.request)
  }

  private drain(): void {
    while (this.running < VIDEO_CONCURRENCY) {
      const task = this.tasks.find(item => item.status === 'queued')
      if (task === undefined) return
      this.running += 1
      void this.runTask(task).finally(() => {
        this.running -= 1
        this.drain()
      })
    }
  }

  private async runTask(task: VideoTask): Promise<void> {
    task.status = 'running'
    task.startedAt = Date.now()
    this.publish(task)
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    const clips: string[] = []
    try {
      await this.generate(task, clips, controller.signal)
      if (this.current(task.id)?.status !== 'cancelled') {
        task.status = 'completed'
        task.stage = 'done'
        task.progress = 1
        task.finishedAt = Date.now()
        this.publish(task)
      }
    } catch (error) {
      // Never discard already-downloaded (already-paid-for) shots: keep them on
      // disk as a partial library entry so the user can retry the concat later
      // without re-submitting to Seedance. Only skips when nothing landed.
      if (clips.length > 0) {
        try {
          await this.recordPartial(task, clips)
        } catch {
          // A partial-record failure must not mask the original error below.
        }
      }
      const cancelled = this.current(task.id)?.status === 'cancelled'
      if (!cancelled) {
        task.status = 'failed'
        task.error = error instanceof Error ? error.message : String(error)
        task.finishedAt = Date.now()
        this.publish(task)
      }
    } finally {
      this.controllers.delete(task.id)
    }
  }

  /** Persist the downloaded clips of a failed/cancelled task as a partial row. */
  private async recordPartial(task: VideoTask, clips: string[]): Promise<void> {
    const upstream = this.resolve().upstream
    const shots = task.request.shots
    await recordPartialVideo({
      id: task.id,
      createdAt: task.createdAt,
      title: task.request.title ?? '',
      model: task.request.model !== '' ? task.request.model : upstream.model,
      prompt: shots.map(shot => shot.prompt).filter(Boolean).join('\n'),
      ratio: task.request.ratio,
      resolution: task.request.resolution,
      duration: shots.reduce((sum, shot) => sum + (shot.duration > 0 ? shot.duration : task.request.duration), 0),
      shots: shots.length,
      clips,
      ...(task.request.channelId === undefined ? {} : { channelId: task.request.channelId }),
    })
  }

  /**
   * Concatenate the already-downloaded clips of a partial library entry into a
   * finished cut (no upstream calls) and flip the entry to completed. Returns
   * the refreshed library so the panel can repaint the new player.
   */
  async concatStored(id: string): Promise<VideoHistoryEntry[]> {
    const info = await getPartialConcatInfo(id)
    if (info === undefined) throw new VideoGenError('未找到可拼接的已下载镜头片段', 'video-partial-missing')
    const root = videoFilesDir()
    const present: string[] = []
    for (const clip of info.clips) {
      const abs = path.join(root, clip)
      try {
        await fs.access(abs)
        present.push(abs)
      } catch {
        // Skip a clip whose file is gone; concat whatever survived.
      }
    }
    if (present.length === 0) throw new VideoGenError('已下载的镜头片段文件不存在，无法拼接', 'video-clips-missing')
    const finalRel = await stampedFinalRelPath(Date.now())
    const finalAbs = path.join(root, finalRel)
    const controller = new AbortController()
    await concatClips(present, finalAbs, this.resolve().ffmpegPath, controller.signal)
    return await finalizePartialVideo(id, finalRel)
  }

  /** Shot-by-shot generation then concat + persist. */
  private async generate(task: VideoTask, clips: string[], signal: AbortSignal): Promise<void> {
    const view = this.resolve()
    if (!view.enabled) throw new VideoGenError('视频生成功能当前已关闭', 'video-disabled')
    const upstream = view.upstream
    if (upstream.apiKey.trim() === '') {
      throw new VideoGenError('尚未配置视频生成的 API Key，请在设置中填写。', 'video-key-missing')
    }
    if (upstream.model.trim() === '') {
      throw new VideoGenError('尚未配置视频生成模型，请在设置中填写 Seedance 模型 id。', 'video-model-missing')
    }
    const shots = task.request.shots
    if (shots.length === 0) throw new VideoGenError('没有可生成的分镜', 'video-no-shots')

    const totalUnits = shots.length + CONCAT_WEIGHT
    let doneUnits = 0
    task.stage = 'preparing'
    this.publish(task)

    const clipPaths: string[] = []
    for (const shot of shots) {
      if (signal.aborted === true) throw new VideoGenError('任务已取消', 'cancelled')
      const result = task.shotResults[shot.index]
      result.status = 'running'
      task.stage = `generating-shot-${shot.index + 1}`
      this.publish(task)

      const referenceUrls = shot.referenceUrls.filter(url => url.trim() !== '')
      const spec = {
        prompt: shot.prompt,
        referenceUrls,
        duration: shot.duration > 0 ? shot.duration : task.request.duration,
        ratio: shot.ratio !== '' ? shot.ratio : task.request.ratio,
        resolution: task.request.resolution,
        generateAudio: task.request.generateAudio,
        watermark: task.request.watermark,
        mode: deriveShotMode(referenceUrls),
      }
      try {
        const taskId = await submitSeedanceTask(upstream, spec, signal)
        result.taskId = taskId
        this.publish(task)
        const polled = await pollSeedanceTask(upstream, taskId, signal)
        if (polled.status !== 'succeeded' || polled.videoUrl === undefined) {
          throw new VideoGenError(polled.error ?? '上游视频任务未成功完成', 'upstream-rejected')
        }
        const bytes = await downloadVideo(polled.videoUrl, upstream, signal)
        const clip = clipRelPath(task.id, shot.index)
        await writeVideoFile(clip, bytes)
        clips.push(clip)
        clipPaths.push(path.join(videoFilesDir(), clip))
        result.status = 'completed'
        result.file = clip
        result.url = `${VIDEO_HISTORY_API.file}/${clip}`
      } catch (error) {
        result.status = this.current(task.id)?.status === 'cancelled' ? 'cancelled' : 'failed'
        result.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        doneUnits += 1
        task.progress = Math.min(0.95, doneUnits / totalUnits)
        this.publish(task)
      }
    }

    // Concatenate clips into the finished cut.
    task.stage = 'concatenating'
    this.publish(task)
    const finalRel = await stampedFinalRelPath(Date.now())
    const finalAbs = path.join(videoFilesDir(), finalRel)
    await concatClips(clipPaths, finalAbs, view.ffmpegPath, signal)
    task.progress = 1
    this.publish(task)

    // Persist through the store (moves the just-written final into the index).
    const finished = await readVideoFile(finalRel)
    if (finished === undefined) throw new VideoGenError('成片写入后无法读取', 'video-store-failed')
    const promptSummary = shots.map(shot => shot.prompt).filter(Boolean).join('\n')
    await appendVideo({
      id: task.id,
      createdAt: Date.now(),
      title: task.request.title ?? '',
      model: upstream.model,
      prompt: promptSummary,
      ratio: task.request.ratio,
      resolution: task.request.resolution,
      duration: shots.reduce((sum, shot) => sum + (shot.duration > 0 ? shot.duration : task.request.duration), 0),
      shots: shots.length,
      file: finalRel,
      clips,
      ...(task.request.channelId === undefined ? {} : { channelId: task.request.channelId }),
    })
    task.finalUrl = `${VIDEO_HISTORY_API.file}/${finalRel}`
    task.fileId = finalRel
  }

  private current(id: string): VideoTask | undefined {
    return this.tasks.find(item => item.id === id)
  }

  private publish(task: VideoTask): void {
    const snapshot = this.snapshot(task)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Observers must never interrupt the queue pump.
      }
    }
  }

  private snapshot(task: VideoTask): VideoTask {
    return {
      ...task,
      request: { ...task.request, shots: task.request.shots.map(shot => ({ ...shot })) },
      shotResults: task.shotResults.map(result => ({ ...result })),
    }
  }
}

/** Run one ffmpeg invocation, rejecting on a non-zero exit code. */
function runFfmpeg(args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const onAbort = () => { child.kill('SIGKILL') }
    if (signal.aborted === true) onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', error => {
      signal.removeEventListener('abort', onAbort)
      reject(new VideoGenError(`无法启动 ffmpeg：${error instanceof Error ? error.message : String(error)}`, 'ffmpeg-unavailable'))
    })
    child.on('close', code => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted === true) reject(new VideoGenError('任务已取消', 'cancelled'))
      else if (code === 0) resolve()
      else reject(new VideoGenError(`ffmpeg 拼接失败（退出码 ${code}）：${stderr.slice(-300)}`, 'ffmpeg-failed'))
    })
  })
}

/**
 * Concatenate the per-shot clips into one mp4. Tries a fast stream-copy via the
 * concat demuxer (works when every shot shares codec + resolution, the common
 * case for a single-model cut); on failure falls back to a re-encode, and
 * finally to a video-only re-encode for silent clips.
 */
async function concatClips(clipPaths: string[], outPath: string, ffmpegPath: string, signal: AbortSignal): Promise<void> {
  if (clipPaths.length === 0) throw new VideoGenError('没有可用于拼接的分镜片段', 'video-no-clips')
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  if (clipPaths.length === 1) {
    // A single shot is already the finished cut: just copy it into place.
    const data = await fs.readFile(clipPaths[0]!)
    await fs.writeFile(outPath, data)
    return
  }
  const listFile = path.join(tmpdir(), `dsh-video-concat-${randomUUID()}.txt`)
  const listBody = clipPaths.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n')
  await fs.writeFile(listFile, listBody, 'utf8')
  const inputArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile]
  try {
    try {
      await runFfmpeg([ffmpegPath, ...inputArgs, '-c', 'copy', outPath], signal)
      return
    } catch (copyError) {
      // Uniform copy failed (mixed codec / resolution / audio layouts) — re-encode.
      try {
        await runFfmpeg([
          ffmpegPath, ...inputArgs,
          '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-ar', '44100', '-ac', '2',
          outPath,
        ], signal)
        return
      } catch (reEncodeError) {
        if (signal.aborted === true) throw reEncodeError
        // Last resort: drop audio entirely (some Seedance clips have none).
        try {
          await runFfmpeg([
            ffmpegPath, ...inputArgs,
            '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an',
            outPath,
          ], signal)
          return
        } catch (finalError) {
          void copyError
          throw finalError instanceof VideoGenError ? finalError : reEncodeError
        }
      }
    }
  } finally {
    try { await fs.rm(listFile, { force: true }) } catch { /* ignore */ }
  }
}

export type { VideoTaskStatus }
