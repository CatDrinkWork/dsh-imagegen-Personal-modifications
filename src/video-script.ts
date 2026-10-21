/**
 * Multimodal storyboard parser: feed the browser-sampled video frames and any
 * uploaded stills to a vision chat model and get back a director-style,
 * user-editable {@link VideoScript}. Reuses the same OpenAI-compatible chat
 * seam the prompt enhancer uses ({@link chatComplete} + {@link jsonPayload})
 * so the video feature never introduces its own transport.
 */

import { chatComplete, jsonPayload, type ChatPart, type PromptModelConfig } from './prompt-enhancer.ts'
import type { VideoScript, VideoScriptAnalyzeRequest, VideoShot } from './protocol.ts'

/** System prompt: force a strict-JSON, editable storyboard. */
const SYSTEM_PROMPT = [
  'You are a professional short-video director and prompt engineer.',
  'Given the user reference material (video frames and/or still images) and their request,',
  'produce a shot-by-shot storyboard that can be fed to a text/image-to-video model.',
  'Return STRICT JSON ONLY, no prose and no markdown fences, in this exact shape:',
  '{"title":"...","narrative":"...","shots":[{"index":0,"text":"...","prompt":"...","duration":5,"ratio":"16:9"}]}',
  'Rules:',
  '- "narrative" is the overall voiceover / story description.',
  '- "shots" is ordered; each "prompt" is one self-contained motion prompt describing camera, subject, action, and style for that clip.',
  '- "text" is a short on-screen beat/caption for the shot.',
  '- "duration" is an integer number of seconds (typically 3-10).',
  '- "ratio" is one of 16:9, 9:16, 1:1, 4:3, 3:4, 21:9.',
  '- ALWAYS write "title", "narrative", "text", and "prompt" in Simplified Chinese, regardless of the language of the user request or the reference material. Translate any non-Chinese input into natural Chinese.',
  '- Match the number of shots to the material; when there is no reference, split the request into sensible scenes.',
].join('\n')

/** Clamp one parsed duration into a sane per-shot range. */
function clampDuration(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(30, Math.max(1, Math.round(parsed)))
}

/** Keep only ratios the video models understand; fall back to the wide default. */
function normalizeRatio(value: unknown, fallback: string): string {
  const allowed = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3'])
  const text = typeof value === 'string' ? value.trim() : ''
  return allowed.has(text) ? text : fallback
}

/** Coerce one parsed shot record into a VideoShot with stable index/order. */
function toShot(value: unknown, index: number, defaultRatio: string): VideoShot | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  if (prompt === '' && text === '') return undefined
  return {
    index,
    text,
    prompt,
    referenceUrls: [],
    duration: clampDuration(record.duration, 5),
    ratio: normalizeRatio(record.ratio, defaultRatio),
  }
}

/** Turn the raw model JSON into a validated, ordered VideoScript. */
function parseScript(payload: unknown, defaultRatio: string): VideoScript | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  // Some models return the shots array directly instead of wrapping it.
  const record = Array.isArray(payload) ? { shots: payload } : payload as Record<string, unknown>
  const rawShots = Array.isArray(record.shots) ? record.shots : Array.isArray(payload) ? payload : []
  const shots: VideoShot[] = []
  for (const item of rawShots) {
    const shot = toShot(item, shots.length, defaultRatio)
    if (shot !== undefined) shots.push(shot)
  }
  if (shots.length === 0) return undefined
  return {
    title: typeof record.title === 'string' ? record.title.trim() : '',
    narrative: typeof record.narrative === 'string' ? record.narrative.trim() : '',
    shots,
  }
}

/**
 * Parse the analyze request into an editable script. Reference frames/stills
 * become inline image_url parts; the request text and optional instruction are
 * appended as the final text part.
 */
export async function analyzeVideoScript(
  config: PromptModelConfig,
  request: VideoScriptAnalyzeRequest,
  defaultRatio = '16:9',
  signal?: AbortSignal,
): Promise<VideoScript> {
  const parts: ChatPart[] = []
  for (const frame of request.frames) {
    if (typeof frame === 'string' && frame.startsWith('data:')) parts.push({ type: 'image_url', image_url: { url: frame } })
  }
  for (const image of request.images) {
    if (typeof image === 'string' && image.startsWith('data:')) parts.push({ type: 'image_url', image_url: { url: image } })
  }
  const brief = [
    request.prompt.trim() === '' ? 'Create a short video storyboard from the reference material.' : request.prompt.trim(),
    request.instruction !== undefined && request.instruction.trim() !== '' ? `Extra instruction: ${request.instruction.trim()}` : '',
    parts.length === 0 ? 'No reference media was provided — invent the shots from the text alone.' : '',
  ].filter(line => line !== '').join('\n')
  parts.push({ type: 'text', text: brief })

  const answer = await chatComplete(config, {
    system: SYSTEM_PROMPT,
    content: parts,
    temperature: 0.6,
    ...(signal === undefined ? {} : { signal }),
  })
  const script = parseScript(jsonPayload(answer), defaultRatio)
  if (script === undefined) throw new Error('解析模型没有返回有效的分镜脚本 JSON')
  return script
}
