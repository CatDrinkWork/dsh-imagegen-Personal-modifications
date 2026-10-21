import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { GeneratedImage } from './protocol.ts'

const DEFAULT_ROOT = path.join(process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh'), 'dsh-imagegen')
let root = DEFAULT_ROOT

export function imageDataRoot(): string { return root }

export function setImageDataRoot(value: string | undefined): void {
  const trimmed = value?.trim()
  root = trimmed === undefined || trimmed === '' ? DEFAULT_ROOT : path.resolve(trimmed)
}

/** Two-digit zero pad. */
function pad2(value: number): string { return String(value).padStart(2, '0') }
/** Three-digit zero pad (milliseconds). */
function pad3(value: number): string { return String(value).padStart(3, '0') }

/** File extension for a MIME type (image file names). */
function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

/** Accepted stored image names: the legacy flat `<id>-<index>.<ext>` OR the
 *  current `<YYYY-MM-DD>/<HH-mm-ss-mmm>-<index>[-<n>].<ext>` subpath. Both
 *  patterns are anchored and slash-restricted (at most the one date separator),
 *  so a request can never traverse out of the images directory. */
const LEGACY_IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(png|jpg|jpeg|webp|gif)$/
const DATED_IMAGE_RE = /^\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9][a-zA-Z0-9-]*\.(png|jpg|jpeg|webp|gif)$/
export function isStoredImageRelPath(file: string): boolean {
  return LEGACY_IMAGE_RE.test(file) || DATED_IMAGE_RE.test(file)
}

/** Build a stored image's relative path from its generation time: a per-day
 *  folder plus an `HH-mm-ss-mmm-<index>` file name. Forward slashes are used
 *  deliberately so the value doubles as the object-storage key suffix. Store
 *  writes are serialized, but a same-millisecond generation falls back to an
 *  incrementing `-<n>` counter to avoid overwriting an existing file. */
export async function stampedImageRelPath(
  dir: string,
  createdAt: number,
  index: number,
  image: Pick<GeneratedImage, 'mime'>,
): Promise<string> {
  const when = new Date(createdAt)
  const folder = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`
  const stem = `${pad2(when.getHours())}-${pad2(when.getMinutes())}-${pad2(when.getSeconds())}-${pad3(when.getMilliseconds())}`
  const ext = extensionOf(image.mime)
  for (let counter = 0; counter < 1000; counter++) {
    const suffix = counter === 0 ? '' : `-${counter}`
    const file = `${folder}/${stem}-${index}${suffix}.${ext}`
    try {
      await fs.access(path.join(dir, file))
    } catch {
      return file
    }
  }
  return `${folder}/${stem}-${index}-t${Date.now()}.${ext}`
}
