/**
 * Host-persisted video library: finished cuts and their per-shot clips live as
 * files under ~/.dsh/dsh-imagegen/videos/, indexed by an index.json — the same
 * shape the gallery/history stores use, specialized for byte-heavy mp4s. The
 * route layer drives this store directly (framework-free: node:fs only), and
 * the generation runtime writes clip/final files through it.
 *
 * Layout (under the resolved videos root — the configured `videoOutputDir`, or
 * `<imageDataRoot>/videos` when unset):
 *   videos/
 *     index.json
 *     <YYYY-MM-DD>/<HH-mm-ss-mmm>.mp4     (finished cuts)
 *     clips/<entry-id>-<shot>.mp4         (per-shot downloads, kept for retry)
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { VIDEO_HISTORY_API, VIDEO_HISTORY_MAX } from './protocol.ts'
import type { VideoHistoryEntry } from './protocol.ts'
import { imageDataRoot } from './image-storage-path.ts'

/**
 * Custom absolute videos root (from `videoOutputDir`); undefined falls back to
 * `<imageDataRoot>/videos`. Resolved on every read so a settings change or a
 * late `setImageDataRoot()` is honored without a restart.
 */
let customVideosRoot: string | undefined

/** Point the library at a custom directory; an empty value restores the default. */
export function setVideoFilesRoot(value: string | undefined): void {
  const trimmed = value?.trim()
  customVideosRoot = trimmed === undefined || trimmed === '' ? undefined : path.resolve(trimmed)
}

/** Absolute directory the library writes finished cuts + clips under. */
export function videoFilesDir(): string {
  return customVideosRoot ?? path.join(imageDataRoot(), 'videos')
}
function videosDir(): string { return videoFilesDir() }
function indexPath(): string { return path.join(videosDir(), 'index.json') }
function clipsDir(): string { return path.join(videosDir(), 'clips') }

/** Two/three-digit zero pads for stamped file names. */
function pad2(value: number): string { return String(value).padStart(2, '0') }
function pad3(value: number): string { return String(value).padStart(3, '0') }

/** One clip's on-disk record (relative path only). */
interface StoredVideo {
  id: string
  createdAt: number
  title: string
  model: string
  prompt: string
  ratio: string
  resolution: string
  duration: number
  shots: number
  /**
   * Whether the finished cut is present. 'completed' carries a final `file`;
   * 'partial' keeps only the already-downloaded per-shot clips so a later
   * retry can concatenate them without paying Seedance again. A legacy row
   * with no status is treated as 'completed' when it carries a file.
   */
  status?: 'completed' | 'partial'
  /** Relative path of the finished mp4 under videosDir(); absent for partial. */
  file?: string
  /** Optional poster image relative path. */
  poster?: string
  /** Per-shot clip relative paths (kept for retry + cleanup). */
  clips: string[]
  channelId?: string
  channel?: string
}

interface IndexFile {
  entries: StoredVideo[]
}

/** A video the runtime submits for persistence (files already written). */
export interface VideoRecordInput {
  id: string
  createdAt: number
  title: string
  model: string
  prompt: string
  ratio: string
  resolution: string
  duration: number
  shots: number
  /** Finished cut relative path; omit (or '') for a partial record. */
  file?: string
  /** Defaults to 'completed' when `file` is present, else 'partial'. */
  status?: 'completed' | 'partial'
  poster?: string
  clips: string[]
  channelId?: string
  channel?: string
}

// Serializes index read-modify-write so overlapping requests never lose a row.
let pendingMutation: Promise<void> = Promise.resolve()

function mutateVideos<T>(operation: () => Promise<T>): Promise<T> {
  const next = pendingMutation.then(operation, operation)
  pendingMutation = next.then(() => undefined, () => undefined)
  return next
}

/** Acceptable stored video paths: a dated final cut OR a clip under clips/. */
const FINAL_RE = /^\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.mp4$/
const CLIP_RE = /^clips\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.mp4$/
const POSTER_RE = /^\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(jpg|jpeg|png|webp)$/

/** Whether a request path stays inside the videos directory (no traversal). */
export function isStoredVideoRelPath(file: string): boolean {
  return FINAL_RE.test(file) || CLIP_RE.test(file)
}

/** Whether a request path is a valid stored poster image. */
export function isStoredPosterRelPath(file: string): boolean {
  return POSTER_RE.test(file)
}

/** Build a dated relative path for one finished video (dedupes same-ms writes). */
export async function stampedFinalRelPath(createdAt: number): Promise<string> {
  const when = new Date(createdAt)
  const folder = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`
  const stem = `${pad2(when.getHours())}-${pad2(when.getMinutes())}-${pad2(when.getSeconds())}-${pad3(when.getMilliseconds())}`
  for (let counter = 0; counter < 1000; counter++) {
    const file = `${folder}/${stem}${counter === 0 ? '' : `-${counter}`}.mp4`
    try {
      await fs.access(path.join(videosDir(), file))
    } catch {
      return file
    }
  }
  return `${folder}/${stem}-t${Date.now()}.mp4`
}

/** The clips/ relative path for one shot of a given entry. */
export function clipRelPath(entryId: string, index: number): string {
  const safe = entryId.replace(/[^a-zA-Z0-9-]/g, '-') || 'clip'
  return `clips/${safe}-${index}.mp4`
}

/** The clips/ relative path for one entry's poster image. */
export function posterRelPath(entryId: string): string {
  const when = new Date()
  const safe = entryId.replace(/[^a-zA-Z0-9-]/g, '-') || 'poster'
  return `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}/${safe}.jpg`
}

/** Write one file under videosDir(), creating parent directories. */
export async function writeVideoFile(relPath: string, data: Buffer): Promise<void> {
  const abs = path.join(videosDir(), relPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, data)
}

/** MIME type for a stored video / asset file name. */
export function mimeOfVideoFile(file: string): string {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  return 'video/mp4'
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(clipsDir(), { recursive: true })
}

async function readIndex(): Promise<StoredVideo[]> {
  try {
    const raw = await fs.readFile(indexPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return []
    const entries = (parsed as { entries?: unknown }).entries
    if (!Array.isArray(entries)) return []
    return entries.filter(isStoredVideo)
  } catch {
    return []
  }
}

async function writeIndex(entries: StoredVideo[]): Promise<void> {
  await ensureDirs()
  const payload: IndexFile = { entries }
  const tmp = `${indexPath()}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(payload), 'utf8')
  await fs.rename(tmp, indexPath())
}

function isStoredVideo(value: unknown): value is StoredVideo {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.createdAt === 'number'
    && typeof entry.title === 'string'
    && typeof entry.model === 'string'
    && typeof entry.prompt === 'string'
    && Array.isArray(entry.clips)
}

async function removeEntryFiles(entry: StoredVideo): Promise<void> {
  const files = [...(entry.file === undefined || entry.file === '' ? [] : [entry.file]), ...entry.clips, ...entry.poster === undefined ? [] : [entry.poster]]
  for (const file of files) {
    try { await fs.rm(path.join(videosDir(), file), { force: true }) } catch { /* ignore */ }
  }
}

function statusOf(entry: StoredVideo): 'completed' | 'partial' {
  return entry.status ?? (entry.file !== undefined && entry.file !== '' ? 'completed' : 'partial')
}

function toWire(entry: StoredVideo): VideoHistoryEntry {
  const status = statusOf(entry)
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    title: entry.title,
    model: entry.model,
    prompt: entry.prompt,
    ratio: entry.ratio,
    resolution: entry.resolution,
    duration: entry.duration,
    shots: entry.shots,
    status,
    clipCount: entry.clips.length,
    ...(entry.file === undefined || entry.file === ''
      ? {}
      : { url: `${VIDEO_HISTORY_API.file}/${entry.file}` }),
    ...(entry.poster === undefined ? {} : { poster: `${VIDEO_HISTORY_API.file}/${entry.poster}` }),
    ...(entry.channelId === undefined ? {} : { channelId: entry.channelId }),
    ...(entry.channel === undefined ? {} : { channel: entry.channel }),
  }
}

/** List persisted videos, newest first. */
export async function listVideos(): Promise<VideoHistoryEntry[]> {
  return (await readIndex()).map(toWire)
}

/** Build the on-disk record from a runtime submit input. */
function toStored(input: VideoRecordInput): StoredVideo {
  const hasFile = input.file !== undefined && input.file !== ''
  const status = input.status ?? (hasFile ? 'completed' : 'partial')
  return {
    id: input.id,
    createdAt: input.createdAt,
    title: input.title,
    model: input.model,
    prompt: input.prompt,
    ratio: input.ratio,
    resolution: input.resolution,
    duration: input.duration,
    shots: input.shots,
    status,
    ...(hasFile ? { file: input.file } : {}),
    ...(input.poster === undefined ? {} : { poster: input.poster }),
    clips: input.clips,
    ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
    ...(input.channel === undefined ? {} : { channel: input.channel }),
  }
}

/** Insert or replace one record at the head, capping + evicting the oldest. */
async function upsertHead(entry: StoredVideo): Promise<VideoHistoryEntry[]> {
  await ensureDirs()
  const merged = [entry, ...(await readIndex()).filter(item => item.id !== entry.id)]
  const evicted = merged.slice(VIDEO_HISTORY_MAX)
  for (const stale of evicted) await removeEntryFiles(stale)
  const kept = merged.slice(0, VIDEO_HISTORY_MAX)
  await writeIndex(kept)
  return kept.map(toWire)
}

/** Append one finished video (files are already written by the runtime). Caps
 *  the library at {@link VIDEO_HISTORY_MAX}, evicting and deleting the oldest. */
export async function appendVideo(input: VideoRecordInput): Promise<VideoHistoryEntry[]> {
  return mutateVideos(() => upsertHead(toStored(input)))
}

/**
 * Record (or refresh) a partial entry that keeps only the downloaded per-shot
 * clips after a failure/cancel, so a later retry can concatenate them without
 * paying the upstream again. Replaces any existing row with the same id.
 */
export async function recordPartialVideo(input: VideoRecordInput): Promise<VideoHistoryEntry[]> {
  return mutateVideos(() => upsertHead(toStored({ ...input, status: 'partial', file: undefined })))
}

/** The downloaded clip relative paths of a still-partial entry (for retry). */
export async function getPartialConcatInfo(id: string): Promise<{ clips: string[] } | undefined> {
  const entry = (await readIndex()).find(item => item.id === id && statusOf(item) === 'partial')
  if (entry === undefined || entry.clips.length === 0) return undefined
  return { clips: entry.clips }
}

/** Flip a partial entry to completed once its clips have been concatenated. */
export async function finalizePartialVideo(id: string, finalRel: string): Promise<VideoHistoryEntry[]> {
  return mutateVideos(async () => {
    const previous = await readIndex()
    let found = false
    const next = previous.map(entry => {
      if (entry.id !== id || statusOf(entry) !== 'partial') return entry
      found = true
      return { ...entry, file: finalRel, status: 'completed' as const }
    })
    if (!found) throw new Error('未找到待拼接的视频记录')
    await writeIndex(next)
    return next.map(toWire)
  })
}

/** Remove one video (and its clip/final/poster files). */
export async function removeVideo(id: string): Promise<VideoHistoryEntry[]> {
  return mutateVideos(async () => {
    const previous = await readIndex()
    const target = previous.find(entry => entry.id === id)
    if (target !== undefined) await removeEntryFiles(target)
    const kept = previous.filter(entry => entry.id !== id)
    await writeIndex(kept)
    return kept.map(toWire)
  })
}

/** Remove every video and file. */
export async function clearVideos(): Promise<VideoHistoryEntry[]> {
  return mutateVideos(async () => {
    const previous = await readIndex()
    for (const entry of previous) await removeEntryFiles(entry)
    await writeIndex([])
    return []
  })
}

/** Delete orphan clip files for an entry that never completed. */
export async function removeClips(clips: string[]): Promise<void> {
  for (const file of clips) {
    if (!CLIP_RE.test(file)) continue
    try { await fs.rm(path.join(videosDir(), file), { force: true }) } catch { /* ignore */ }
  }
}

/** Read one stored video/asset file by its validated relative path. */
export async function readVideoFile(file: string): Promise<{ data: Buffer; mime: string } | undefined> {
  if (!isStoredVideoRelPath(file) && !isStoredPosterRelPath(file)) return undefined
  try {
    const data = await fs.readFile(path.join(videosDir(), file))
    return { data, mime: mimeOfVideoFile(file) }
  } catch {
    return undefined
  }
}

/** Byte size of one stored file (for Range responses); undefined when absent. */
export async function statVideoFile(file: string): Promise<number | undefined> {
  if (!isStoredVideoRelPath(file) && !isStoredPosterRelPath(file)) return undefined
  try {
    const stat = await fs.stat(path.join(videosDir(), file))
    return stat.size
  } catch {
    return undefined
  }
}

/** Read one byte range of a stored video; returns the slice + total size. */
export async function readVideoRange(
  file: string,
  start: number,
  end: number,
): Promise<{ data: Buffer; size: number } | undefined> {
  if (!isStoredVideoRelPath(file) && !isStoredPosterRelPath(file)) return undefined
  try {
    const abs = path.join(videosDir(), file)
    const stat = await fs.stat(abs)
    const from = Math.max(0, Math.min(start, stat.size - 1))
    const to = Math.max(from, Math.min(end, stat.size - 1))
    const handle = await fs.open(abs, 'r')
    try {
      const buffer = Buffer.alloc(to - from + 1)
      await handle.read(buffer, 0, buffer.length, from)
      return { data: buffer, size: stat.size }
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/** The videos route family prefix (kept here so store + route agree). */
export const VIDEO_FILE_ROUTE = VIDEO_HISTORY_API.file
