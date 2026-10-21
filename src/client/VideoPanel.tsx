/**
 * The AI 视频 studio (即梦 / Seedance): a three-column workbench mirroring the
 * image panel — left, generation parameters (model / ratio / resolution /
 * per-shot duration / audio / watermark); center, the four-step workflow
 * (upload material → parse an editable storyboard → generate per shot → concat
 * and preview); right, a persistent video history column.
 *
 * The heavy lifting (Seedance submit/poll/download + ffmpeg concat) lives
 * host-side behind the video routes; this component only drives the wire
 * through ImageGenApi and renders task progress. Copy rides tt(); controls reuse
 * the system Button/Pill primitives so the studio matches the DSH shell.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { openImageGenConfig } from './config-entry.tsx'
import { useImageGenLanguageTick } from './use-language.ts'
import { extractFrames } from './video-frames.ts'
import { videoDefaults, type ImageGenConfig, type ImageGenScope } from './settings-scope.ts'
import type { VideoGenerateRequest, VideoHistoryEntry, VideoScript, VideoShot, VideoTask } from '../protocol.ts'
import css from './video.module.css'

/** Aspect-ratio presets offered in the config column. */
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const
/** Resolution tiers (Ark Seedance accepts these verbatim). */
const RESOLUTIONS = ['480p', '720p', '1080p'] as const
/** Poll cadence for a running video task (video is slow; keep it light). */
const TASK_POLL_MS = 3000

/** Read the current config from the settings scope snapshot. */
function useConfig(scope: ImageGenScope): ImageGenConfig | undefined {
  const [value, setValue] = useState(scope.getSnapshot().value)
  useEffect(() => scope.subscribe(() => { setValue(scope.getSnapshot().value) }), [scope])
  return value
}

/** Whether one secret field currently holds a stored value. */
function useSecretSet(scope: ImageGenScope, field: string): boolean {
  const [set, setValue] = useState(() => scope.getSecretSetSnapshot(field))
  useEffect(() => scope.subscribeSecretSets(() => { setValue(scope.getSecretSetSnapshot(field)) }), [scope, field])
  return set
}

/** One uploaded still-image reference (its public URL once published). */
interface MaterialImage {
  id: string
  dataUrl: string
  name: string
  /** Populated once the host publishes it to object storage. */
  url?: string
  publishing: boolean
}

/** A published reference URL in the shared pool selectable per shot. */
interface RefPoolItem {
  url: string
  label: string
}

/** Re-index shots after an add/remove/reorder so `index` stays 0-based order. */
function reindex(shots: VideoShot[]): VideoShot[] {
  return shots.map((shot, index) => ({ ...shot, index }))
}

/** Blank storyboard used when the user skips the parse and edits by hand. */
function emptyScript(): VideoScript {
  return { title: '', narrative: '', shots: reindex([{ index: 0, text: '', prompt: '', referenceUrls: [], duration: 0, ratio: '' }]) }
}

/**
 * Rebuild an editable {@link VideoScript} from an imported JSON payload. Mirrors
 * the host parser's normalization (trim, drop empty shots, clamp duration) so a
 * hand-edited or exported file re-enters the same validated shape. Accepts a
 * full script object or a bare array of shots.
 */
function normalizeImportedScript(payload: unknown): VideoScript | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const record = Array.isArray(payload) ? { shots: payload } : payload as Record<string, unknown>
  const rawShots = Array.isArray(record.shots) ? record.shots : []
  const shots: VideoShot[] = []
  for (const item of rawShots) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : ''
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (prompt === '' && text === '') continue
    const parsedDuration = typeof entry.duration === 'number' ? entry.duration : Number(entry.duration)
    const duration = Number.isFinite(parsedDuration) && parsedDuration > 0 ? Math.min(30, Math.max(1, Math.round(parsedDuration))) : 5
    const ratio = typeof entry.ratio === 'string' ? entry.ratio.trim() : ''
    const referenceUrls = Array.isArray(entry.referenceUrls)
      ? entry.referenceUrls.filter((url): url is string => typeof url === 'string' && url.trim() !== '')
      : []
    shots.push({ index: shots.length, text, prompt, referenceUrls, duration, ratio })
  }
  if (shots.length === 0) return undefined
  return {
    title: typeof record.title === 'string' ? record.title.trim() : '',
    narrative: typeof record.narrative === 'string' ? record.narrative.trim() : '',
    shots,
  }
}

function shotStageLabel(stage: string): string {
  const match = /^generating-shot-(\d+)$/.exec(stage)
  if (match !== null) return tt('video.stage.shot', { index: Number(match[1]) + 1 })
  switch (stage) {
    case 'preparing': return tt('video.stage.preparing')
    case 'concatenating': return tt('video.stage.concatenating')
    case 'done': return tt('video.stage.done')
    default: return stage
  }
}

/** Map a task/shot status onto the shared generation-task copy keys. */
function statusLabel(status: VideoTask['status']): string {
  switch (status) {
    case 'queued': return tt('tasks.queued')
    case 'running': return tt('tasks.running')
    case 'completed': return tt('tasks.completed')
    case 'failed': return tt('tasks.failed')
    case 'cancelled': return tt('tasks.cancelled')
  }
}

export function VideoPanel(props: {
  api: ImageGenApi
  scope: ImageGenScope
  /** The panel is visible; inactive panels defer optional polling work. */
  active?: boolean
}) {
  const { api, scope, active = true } = props
  useImageGenLanguageTick()
  const config = useConfig(scope)
  const defaults = useMemo(() => videoDefaults(config), [config])
  const videoKeySet = useSecretSet(scope, 'videoApiKey')

  // ---- configuration column -------------------------------------------------
  const [model, setModel] = useState(defaults.model)
  const [ratio, setRatio] = useState(defaults.ratio)
  const [resolution, setResolution] = useState(defaults.resolution)
  const [duration, setDuration] = useState(defaults.duration)
  const [generateAudio, setGenerateAudio] = useState(false)
  const [watermark, setWatermark] = useState(false)
  // Adopt settings changes until the user touches a field.
  const touched = useRef<Record<string, boolean>>({})
  useEffect(() => {
    if (!touched.current.model) setModel(defaults.model)
    if (!touched.current.ratio) setRatio(defaults.ratio)
    if (!touched.current.resolution) setResolution(defaults.resolution)
    if (!touched.current.duration) setDuration(defaults.duration)
  }, [defaults])

  // ---- material + prompt ----------------------------------------------------
  const [videoFiles, setVideoFiles] = useState<File[]>([])
  const [images, setImages] = useState<MaterialImage[]>([])
  const [prompt, setPrompt] = useState('')
  const [instruction, setInstruction] = useState('')
  const [refPool, setRefPool] = useState<RefPoolItem[]>([])
  const videoInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const scriptInputRef = useRef<HTMLInputElement>(null)

  // ---- workflow state -------------------------------------------------------
  const [analyzing, setAnalyzing] = useState(false)
  const [script, setScript] = useState<VideoScript | null>(null)
  const [task, setTask] = useState<VideoTask | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<VideoHistoryEntry[]>([])
  const [historyBusy, setHistoryBusy] = useState(false)

  const canGenerate = defaults.enabled
    && videoKeySet
    && model.trim() !== ''
    && (script?.shots ?? []).some(shot => shot.prompt.trim() !== '')

  // ---- history load ---------------------------------------------------------
  const refreshHistory = useCallback(async (): Promise<void> => {
    try {
      setHistory(await api.videoHistoryList())
    } catch {
      // History is advisory; the generate flow reports its own errors.
    }
  }, [api])
  useEffect(() => { void refreshHistory() }, [refreshHistory])

  // ---- save location (absolute videos dir) ---------------------------------
  // Resolved host-side so it honors the custom `videoOutputDir` setting; the
  // panel shows the path and offers a reveal button. Re-read when the setting
  // changes so an edit reflects without a reload.
  const [videoDir, setVideoDir] = useState('')
  useEffect(() => {
    let disposed = false
    void api.getVideoFolder()
      .then(result => { if (!disposed && result.ok && typeof result.path === 'string') setVideoDir(result.path) })
      .catch(() => { /* advisory: the reveal button still works without a path */ })
    return () => { disposed = true }
  }, [api, config?.videoOutputDir])

  // ---- storyboard export / import (JSON round-trip) -------------------------
  // Serialize the live storyboard to a downloadable file and read one back, so
  // a user can refine prompts in an external editor and re-feed Seedance.
  const exportScript = (): void => {
    if (script === null) return
    const blob = new Blob([JSON.stringify(script, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${(script.title.trim() || 'storyboard').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40)}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }
  const onPickScriptFile = (files: FileList | null): void => {
    // Reset first so re-importing the same file still fires change.
    if (scriptInputRef.current !== null) scriptInputRef.current.value = ''
    const file = files !== null && files.length > 0 ? files[0] : undefined
    if (file === undefined) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(typeof reader.result === 'string' ? reader.result : '') as unknown
        const next = normalizeImportedScript(parsed)
        if (next === undefined) { setError(tt('video.importFailed', { error: tt('video.importEmpty') })); return }
        setScript(next)
        setError(null)
      } catch (err) {
        setError(tt('video.importFailed', { error: errorMessage(err) }))
      }
    }
    reader.onerror = () => setError(tt('video.importFailed', { error: tt('video.importEmpty') }))
    reader.readAsText(file)
  }

  // ---- task polling ---------------------------------------------------------
  useEffect(() => {
    if (!active || task === null) return
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return
    let disposed = false
    const timer = window.setInterval(async () => {
      try {
        const next = await api.videoTaskGet(task.id)
        if (disposed) return
        setTask(current => current?.id === next.id ? next : current)
        if (next.status === 'completed') { void refreshHistory() }
      } catch {
        // A transient poll failure is retried on the next tick.
      }
    }, TASK_POLL_MS)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [active, task?.id, task?.status, api, refreshHistory])

  // ---- material handlers ----------------------------------------------------
  const onPickVideos = (files: FileList | null): void => {
    if (files === null) return
    setVideoFiles(current => [...current, ...Array.from(files).filter(file => file.type.startsWith('video/'))])
  }
  const onPickImages = (files: FileList | null): void => {
    if (files === null) return
    const picked = Array.from(files).filter(file => file.type.startsWith('image/'))
    void Promise.all(picked.map(async file => ({
      id: `${Date.now()}-${file.name}`,
      dataUrl: await readDataUrl(file),
      name: file.name,
      publishing: false,
    }))).then(loaded => setImages(current => [...current, ...loaded]))
  }

  const publishImage = useCallback(async (image: MaterialImage): Promise<void> => {
    setImages(current => current.map(item => item.id === image.id ? { ...item, publishing: true } : item))
    try {
      const url = await api.videoAssetPublish(image.dataUrl, image.name)
      setImages(current => current.map(item => item.id === image.id ? { ...item, url, publishing: false } : item))
      setRefPool(current => current.some(entry => entry.url === url) ? current : [...current, { url, label: image.name }])
    } catch (err) {
      setImages(current => current.map(item => item.id === image.id ? { ...item, publishing: false } : item))
      setError(errorMessage(err))
    }
  }, [api])

  // ---- analyze --------------------------------------------------------------
  const analyze = useCallback(async (): Promise<void> => {
    setError(null)
    setAnalyzing(true)
    try {
      const frames: string[] = []
      for (const file of videoFiles) {
        const extracted = await extractFrames(file, 6)
        frames.push(...extracted)
        if (frames.length >= 24) break
      }
      const imageUrls = images.map(image => image.dataUrl).filter(url => url !== '')
      if (frames.length === 0 && imageUrls.length === 0 && prompt.trim() === '') {
        setError(tt('video.needMaterial'))
        return
      }
      const parsed = await api.videoAnalyze({ frames: frames.slice(0, 24), images: imageUrls.slice(0, 12), prompt, instruction: instruction.trim() === '' ? undefined : instruction.trim() })
      setScript({ ...parsed, shots: reindex(parsed.shots.length > 0 ? parsed.shots : emptyScript().shots) })
    } catch (err) {
      setError(tt('video.analyzeFailed', { error: errorMessage(err) }))
    } finally {
      setAnalyzing(false)
    }
  }, [api, images, instruction, prompt, videoFiles])

  // ---- script editing -------------------------------------------------------
  const patchShot = (index: number, patch: Partial<VideoShot>): void => {
    setScript(current => current === null ? current : ({ ...current, shots: reindex(current.shots.map((shot, i) => i === index ? { ...shot, ...patch } : shot)) }))
  }
  const addShot = (): void => {
    setScript(current => current === null ? emptyScript() : ({ ...current, shots: reindex([...current.shots, { index: current.shots.length, text: '', prompt: '', referenceUrls: [], duration: 0, ratio: '' }]) }))
  }
  const removeShot = (index: number): void => {
    setScript(current => current === null ? current : ({ ...current, shots: reindex(current.shots.filter((_, i) => i !== index)) }))
  }
  const moveShot = (index: number, delta: number): void => {
    setScript(current => {
      if (current === null) return current
      const target = index + delta
      if (target < 0 || target >= current.shots.length) return current
      const shots = [...current.shots]
      const [moved] = shots.splice(index, 1)
      shots.splice(target, 0, moved!)
      return { ...current, shots: reindex(shots) }
    })
  }
  const toggleShotRef = (index: number, url: string): void => {
    setScript(current => {
      if (current === null) return current
      const shots = current.shots.map((shot, i) => {
        if (i !== index) return shot
        const has = shot.referenceUrls.includes(url)
        return { ...shot, referenceUrls: has ? shot.referenceUrls.filter(item => item !== url) : [...shot.referenceUrls, url] }
      })
      return { ...current, shots: reindex(shots) }
    })
  }

  // ---- generate -------------------------------------------------------------
  const submit = useCallback(async (): Promise<void> => {
    setError(null)
    const shots = (script?.shots ?? []).filter(shot => shot.prompt.trim() !== '')
    if (shots.length === 0) { setError(tt('video.needPrompt')); return }
    const request: VideoGenerateRequest = {
      shots: reindex(shots),
      model: model.trim(),
      ratio,
      resolution,
      duration,
      generateAudio,
      watermark,
      ...script?.title ? { title: script.title } : {},
      ...script?.narrative ? { narrative: script.narrative } : {},
    }
    setSubmitting(true)
    try {
      const created = await api.videoTaskSubmit(request)
      setTask(created)
    } catch (err) {
      setError(tt('video.submitFailed', { error: errorMessage(err) }))
    } finally {
      setSubmitting(false)
    }
  }, [api, duration, generateAudio, model, ratio, resolution, script, watermark])

  const cancelTask = useCallback(async (): Promise<void> => {
    if (task === null) return
    try { setTask(await api.videoTaskCancel(task.id)) } catch { /* ignore */ }
  }, [api, task])

  const retryTask = useCallback(async (): Promise<void> => {
    if (task === null) return
    setError(null)
    try { setTask(await api.videoTaskRetry(task.id)) } catch (err) { setError(tt('video.submitFailed', { error: errorMessage(err) })) }
  }, [api, task])

  // ---- history actions ------------------------------------------------------
  const restoreHistory = (entry: VideoHistoryEntry): void => {
    setScript({ title: entry.title, narrative: '', shots: reindex(Array.from({ length: Math.max(1, entry.shots) }, (_, i) => ({ index: i, text: '', prompt: i === 0 ? entry.prompt : '', referenceUrls: [], duration: entry.duration, ratio: entry.ratio }))) })
    setModel(entry.model || model)
    setRatio(entry.ratio || ratio)
    setResolution(entry.resolution || resolution)
  }
  const removeHistory = async (id: string): Promise<void> => {
    setHistoryBusy(true)
    try { setHistory(await api.videoHistoryRemove(id)) } finally { setHistoryBusy(false) }
  }
  const clearHistory = async (): Promise<void> => {
    if (!window.confirm(tt('video.history.clearConfirm'))) return
    setHistoryBusy(true)
    try { setHistory(await api.videoHistoryClear()) } finally { setHistoryBusy(false) }
  }
  const concatHistory = async (id: string): Promise<void> => {
    setHistoryBusy(true)
    setError(null)
    try { setHistory(await api.videoHistoryConcat(id)) } 
    catch (err) { setError(tt('video.concatFailed', { error: errorMessage(err) })) }
    finally { setHistoryBusy(false) }
  }

  const showConfigBanner = !defaults.enabled || !videoKeySet || model.trim() === ''

  return (
    <div className={css.panel}>
      <header className={css.header}>
        <h2 className={css.title}>{tt('video.title')}</h2>
        <span className={css.status} data-ok={String(defaults.enabled && videoKeySet)}>
          <span className={css.statusDot} />
          {defaults.enabled && videoKeySet ? tt('connection.connected') : tt('connection.disconnected')}
        </span>
      </header>

      <div className={css.columns}>
        {/* --------------------------- config column --------------------------- */}
        <aside className={css.config}>
          <div className={css.field}>
            <label className={css.label}>{tt('video.model')}</label>
            <input
              className={css.input}
              value={model}
              placeholder={tt('video.modelPlaceholder')}
              onChange={event => { touched.current.model = true; setModel(event.target.value) }}
            />
          </div>
          <div className={css.field}>
            <label className={css.label}>{tt('video.ratio')}</label>
            <div className={css.chips}>
              {RATIOS.map(item => (
                <button key={item} type="button" className={css.chip} data-active={String(item === ratio)} onClick={() => { touched.current.ratio = true; setRatio(item) }}>{item}</button>
              ))}
            </div>
          </div>
          <div className={css.field}>
            <label className={css.label}>{tt('video.resolution')}</label>
            <div className={css.chips}>
              {RESOLUTIONS.map(item => (
                <button key={item} type="button" className={css.chip} data-active={String(item === resolution)} onClick={() => { touched.current.resolution = true; setResolution(item) }}>{item}</button>
              ))}
            </div>
          </div>
          <div className={css.field}>
            <label className={css.label}>{tt('video.duration')}</label>
            <input
              className={css.input}
              type="number"
              min={1}
              max={30}
              value={duration}
              onChange={event => { touched.current.duration = true; setDuration(Math.max(1, Math.min(30, Number(event.target.value) || 1))) }}
            />
          </div>
          <label className={css.switch}>
            <input type="checkbox" checked={generateAudio} onChange={event => setGenerateAudio(event.target.checked)} />
            <span>{tt('video.generateAudio')}</span>
          </label>
          <label className={css.switch}>
            <input type="checkbox" checked={watermark} onChange={event => setWatermark(event.target.checked)} />
            <span>{tt('video.watermark')}</span>
          </label>
          <div className={css.field}>
            <label className={css.label}>{tt('video.saveLocation')}</label>
            <p className={css.hint} title={videoDir}>{videoDir !== '' ? videoDir : tt('video.saveLocationLoading')}</p>
            <Button size="sm" variant="outline" onClick={() => { void api.openVideoFolder() }}>{tt('video.openFolder')}</Button>
          </div>
        </aside>

        {/* -------------------------- workspace column ------------------------- */}
        <section className={css.workspace}>
          {showConfigBanner ? (
            <div className={css.banner}>
              <span>{!defaults.enabled ? tt('video.configDisabled') : !videoKeySet ? tt('video.configMissing') : tt('video.noModel')}</span>
              <Button size="sm" variant="outline" onClick={() => openImageGenConfig()}>{tt('canvas.openSettings')}</Button>
            </div>
          ) : null}

          {/* step 1: material */}
          <div className={css.block}>
            <div className={css.blockHead}>
              <span className={css.stepBadge}>1</span>
              <strong>{tt('video.materialTitle')}</strong>
            </div>
            <p className={css.hint}>{tt('video.materialHint')}</p>
            <div className={css.uploadRow}>
              <Button size="sm" variant="outline" onClick={() => videoInputRef.current?.click()}>{tt('video.uploadVideos')}</Button>
              <Button size="sm" variant="outline" onClick={() => imageInputRef.current?.click()}>{tt('video.uploadImages')}</Button>
            </div>
            <input ref={videoInputRef} type="file" accept="video/*" multiple hidden onChange={event => onPickVideos(event.target.files)} />
            <input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={event => onPickImages(event.target.files)} />
            {videoFiles.length > 0 ? (
              <div className={css.clipList}>
                {videoFiles.map((file, i) => (
                  <span key={`${file.name}-${i}`} className={css.clipChip}>
                    {file.name}
                    <button type="button" className={css.clipRemove} onClick={() => setVideoFiles(current => current.filter((_, index) => index !== i))}>×</button>
                  </span>
                ))}
              </div>
            ) : null}
            {images.length > 0 ? (
              <div className={css.imageGrid}>
                {images.map(image => (
                  <div key={image.id} className={css.imageCard}>
                    {image.dataUrl !== '' ? <img src={image.dataUrl} alt={image.name} /> : <div className={css.imagePlaceholder} />}
                    <div className={css.imageActions}>
                      {image.url === undefined ? (
                        <Button size="sm" variant="ghost" disabled={image.publishing} onClick={() => void publishImage(image)}>{image.publishing ? tt('video.publishing') : tt('video.publishImage')}</Button>
                      ) : (
                        <Pill active>{tt('video.published')}</Pill>
                      )}
                      <button type="button" className={css.clipRemove} onClick={() => setImages(current => current.filter(item => item.id !== image.id))}>×</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {/* step 2: prompt + parse */}
          <div className={css.block}>
            <div className={css.blockHead}>
              <span className={css.stepBadge}>2</span>
              <strong>{tt('video.promptTitle')}</strong>
            </div>
            <textarea className={css.textarea} rows={3} value={prompt} placeholder={tt('video.promptPlaceholder')} onChange={event => setPrompt(event.target.value)} />
            <input className={css.input} value={instruction} placeholder={tt('video.instructionPlaceholder')} onChange={event => setInstruction(event.target.value)} />
            <div className={css.blockActions}>
              <Button variant="primary" disabled={analyzing} onClick={() => void analyze()}>{analyzing ? tt('video.analyzing') : tt('video.analyze')}</Button>
              <Button variant="outline" onClick={() => scriptInputRef.current?.click()}>{tt('video.importScript')}</Button>
            </div>
            <input ref={scriptInputRef} type="file" accept="application/json,.json" hidden onChange={event => onPickScriptFile(event.target.files)} />
          </div>

          {/* step 3: storyboard editor */}
          {script !== null ? (
            <div className={css.block}>
              <div className={css.blockHead}>
                <span className={css.stepBadge}>3</span>
                <strong>{tt('video.scriptTitle')}</strong>
                <span className={css.count}>{tt('video.shotsCount', { count: script.shots.length })}</span>
              </div>
              <input className={css.input} value={script.title} placeholder={tt('video.scriptTitlePlaceholder')} onChange={event => setScript({ ...script, title: event.target.value })} />
              <textarea className={css.textarea} rows={2} value={script.narrative} placeholder={tt('video.narrativePlaceholder')} onChange={event => setScript({ ...script, narrative: event.target.value })} />
              {script.shots.map((shot, index) => (
                <div key={index} className={css.shotCard}>
                  <div className={css.shotHead}>
                    <span className={css.shotIndex}>{tt('video.shotLabel', { index: index + 1 })}</span>
                    <button type="button" className={css.shotBtn} disabled={index === 0} onClick={() => moveShot(index, -1)} title={tt('video.moveUp')}>↑</button>
                    <button type="button" className={css.shotBtn} disabled={index === script.shots.length - 1} onClick={() => moveShot(index, 1)} title={tt('video.moveDown')}>↓</button>
                    <button type="button" className={css.shotBtn} disabled={script.shots.length <= 1} onClick={() => removeShot(index)} title={tt('video.removeShot')}>×</button>
                  </div>
                  <textarea className={css.textarea} rows={2} value={shot.prompt} placeholder={tt('video.shotPromptPlaceholder')} onChange={event => patchShot(index, { prompt: event.target.value })} />
                  <div className={css.shotParams}>
                    <label className={css.miniField}>{tt('video.shotDuration')}
                      <input type="number" min={0} max={30} value={shot.duration} onChange={event => patchShot(index, { duration: Math.max(0, Number(event.target.value) || 0) })} />
                    </label>
                    <label className={css.miniField}>{tt('video.shotRatio')}
                      <input value={shot.ratio} placeholder={ratio} onChange={event => patchShot(index, { ratio: event.target.value })} />
                    </label>
                  </div>
                  {shot.referenceUrls.length > 0 ? (
                    <div className={css.refChips}>
                      {shot.referenceUrls.map(url => (
                        <button key={url} type="button" className={css.refChip} onClick={() => toggleShotRef(index, url)} title={tt('video.removeRef')}>{shortUrl(url)} ×</button>
                      ))}
                    </div>
                  ) : null}
                  {refPool.length > 0 ? (
                    <div className={css.refPool}>
                      {refPool.map(ref => (
                        <button key={ref.url} type="button" className={css.refPoolItem} data-on={String(shot.referenceUrls.includes(ref.url))} onClick={() => toggleShotRef(index, ref.url)}>{ref.label}</button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              <div className={css.blockActions}>
                <Button size="sm" variant="outline" onClick={addShot}>{tt('video.addShot')}</Button>
                <Button size="sm" variant="outline" onClick={exportScript}>{tt('video.exportScript')}</Button>
              </div>
            </div>
          ) : null}

          {/* step 4: generate + result */}
          <div className={css.block}>
            <div className={css.blockHead}>
              <span className={css.stepBadge}>4</span>
              <strong>{tt('video.generateTitle')}</strong>
            </div>
            {error !== null ? <div className={css.error}>{error}</div> : null}
            <div className={css.blockActions}>
              <Button variant="primary" disabled={!canGenerate || submitting} onClick={() => void submit()}>{submitting ? tt('video.submitting') : tt('video.generate')}</Button>
              {task !== null && (task.status === 'queued' || task.status === 'running') ? (
                <Button variant="outline" onClick={() => void cancelTask()}>{tt('video.cancel')}</Button>
              ) : null}
              {task !== null && (task.status === 'failed' || task.status === 'cancelled') ? (
                <Button variant="outline" onClick={() => void retryTask()}>{tt('video.retry')}</Button>
              ) : null}
            </div>

            {task !== null ? (
              <div className={css.progress}>
                <div className={css.progressHead}>
                  <span>{shotStageLabel(task.stage)}</span>
                  <span>{Math.round(task.progress * 100)}%</span>
                </div>
                <div className={css.progressTrack}><div className={css.progressFill} style={{ width: `${Math.round(task.progress * 100)}%` }} /></div>
                <div className={css.shotStatusList}>
                  {task.shotResults.map(shot => (
                    <span key={shot.index} className={css.shotStatus} data-status={shot.status}>{tt('video.shotLabel', { index: shot.index + 1 })} · {statusLabel(shot.status)}</span>
                  ))}
                </div>
                {task.error !== undefined ? <div className={css.error}>{task.error}</div> : null}
              </div>
            ) : null}

            {task?.status === 'completed' && task.finalUrl !== undefined ? (
              <div className={css.result}>
                <video className={css.player} src={task.finalUrl} controls playsInline />
                <div className={css.resultActions}>
                  <a className={css.download} href={task.finalUrl} download={`video-${task.id}.mp4`}>{tt('video.download')}</a>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {/* --------------------------- history column -------------------------- */}
        <aside className={css.history}>
          <div className={css.historyHead}>
            <strong>{tt('video.historyTitle')}</strong>
            <button type="button" className={css.historyClear} disabled={historyBusy || history.length === 0} onClick={() => void clearHistory()}>{tt('video.history.clear')}</button>
          </div>
          {history.length === 0 ? (
            <p className={css.hint}>{tt('video.history.empty')}</p>
          ) : (
            <div className={css.historyList}>
              {history.map(entry => (
                <div key={entry.id} className={css.historyItem}>
                  {entry.status === 'partial' ? <div className={css.historyPosterEmpty} /> : entry.poster !== undefined ? <img className={css.historyPoster} src={entry.poster} alt={entry.title} /> : <div className={css.historyPosterEmpty} />}
                  <div className={css.historyMeta}>
                    <strong title={entry.title}>{entry.title || tt('video.untitled')}</strong>
                    <small>{entry.model} · {entry.ratio} · {tt('video.history.shots', { count: entry.shots })}</small>
                    {entry.status === 'partial' ? (
                      <small className={css.historyPartial}>{tt('video.history.partial', { count: entry.clipCount ?? entry.shots })}</small>
                    ) : null}
                    {entry.url !== undefined ? <video className={css.historyPreview} src={entry.url} muted preload="metadata" /> : null}
                  </div>
                  <div className={css.historyActions}>
                    {entry.status === 'partial' ? (
                      <button type="button" className={css.historyBtn} disabled={historyBusy} onClick={() => void concatHistory(entry.id)}>{tt('video.history.concat')}</button>
                    ) : null}
                    <button type="button" className={css.historyBtn} onClick={() => restoreHistory(entry)}>{tt('video.history.restore')}</button>
                    <button type="button" className={css.historyBtn} onClick={() => void removeHistory(entry.id)}>{tt('video.history.delete')}</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

/** Read one image File into a data URL. */
async function readDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(typeof reader.result === 'string' ? reader.result : '') }
    reader.onerror = () => { reject(reader.error) }
    reader.readAsDataURL(file)
  })
}

/** Trim a long URL to a compact chip label. */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const tail = parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.hostname
    return tail.length > 24 ? `${tail.slice(0, 21)}…` : tail
  } catch {
    return url.length > 24 ? `${url.slice(0, 21)}…` : url
  }
}
