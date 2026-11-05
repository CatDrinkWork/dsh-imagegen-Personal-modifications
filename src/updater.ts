/** GitHub Release discovery and explicit, user-triggered plugin updates. */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLUGIN_VERSION } from './protocol.ts'

/** Keep this in sync with package.json for each published release. */
export const CURRENT_VERSION = PLUGIN_VERSION
export const PACKAGE_NAME = '@dickpy/dsh-imagegen'
export const RELEASES_URL = 'https://api.github.com/repos/CatDrinkWork/dsh-imagegen-Personal-modifications/releases/latest'

const CHECK_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 15 * 60_000
/** Release tarballs can be tens of MB; allow a generous download window. */
const DOWNLOAD_TIMEOUT_MS = 120_000

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
  publishedAt?: string
  /** Markdown release body shown in the update popover. */
  releaseNotes?: string
  /** Direct download URL of the release `.tgz` asset, when one is attached. */
  downloadUrl?: string
}

interface GitHubRelease {
  tag_name?: unknown
  html_url?: unknown
  published_at?: unknown
  body?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: unknown
}

let cached: { expiresAt: number; value: UpdateInfo } | undefined

/** Compare stable semver triples; returns positive when `left` is newer. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number] => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
    if (match === null) return [0, 0, 0]
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const a = parse(left)
  const b = parse(right)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

function normalizedReleaseVersion(tag: unknown): string | undefined {
  if (typeof tag !== 'string' || !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag.trim())) return undefined
  return tag.trim().replace(/^v/, '')
}

/** Pick the first `.tgz` release asset's direct download URL, if present. */
function pickTarballDownloadUrl(assets: unknown): string | undefined {
  if (!Array.isArray(assets)) return undefined
  for (const asset of assets) {
    if (asset === null || typeof asset !== 'object') continue
    const name = (asset as { name?: unknown }).name
    const url = (asset as { browser_download_url?: unknown }).browser_download_url
    if (typeof name === 'string' && name.endsWith('.tgz') && typeof url === 'string' && url !== '') return url
  }
  return undefined
}

/** Read the latest stable GitHub Release, with a short host-side cache. */
export async function checkForUpdate(fetchFn: typeof fetch = fetch, now = Date.now()): Promise<UpdateInfo> {
  if (cached !== undefined && cached.expiresAt > now) return cached.value
  const response = await fetchFn(RELEASES_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-imagegen-update-check',
    },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`)
  const payload: unknown = await response.json()
  if (payload === null || typeof payload !== 'object') throw new Error('GitHub Releases returned malformed JSON')
  const release = payload as GitHubRelease
  if (release.draft === true || release.prerelease === true) throw new Error('latest GitHub Release is not stable')
  const latestVersion = normalizedReleaseVersion(release.tag_name)
  if (latestVersion === undefined) throw new Error('latest GitHub Release has an invalid version tag')
  const releaseUrl = typeof release.html_url === 'string' ? release.html_url : 'https://github.com/CatDrinkWork/dsh-imagegen-Personal-modifications/releases'
  const releaseNotes = typeof release.body === 'string' ? release.body.trim() : ''
  const downloadUrl = pickTarballDownloadUrl(release.assets)
  const value: UpdateInfo = {
    currentVersion: CURRENT_VERSION,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, CURRENT_VERSION) > 0,
    releaseUrl,
    ...typeof release.published_at === 'string' ? { publishedAt: release.published_at } : {},
    ...releaseNotes === '' ? {} : { releaseNotes: releaseNotes.slice(0, 20_000) },
    ...downloadUrl === undefined ? {} : { downloadUrl },
  }
  cached = { expiresAt: now + CACHE_TTL_MS, value }
  return value
}

/** Resolve the profile that launched the current DSH process. */
export function profileFromProcess(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  const envProfile = env.DSH_PROFILE?.trim()
  if (envProfile !== undefined && /^[a-zA-Z0-9_-]+$/.test(envProfile)) return envProfile
  const profileIndex = argv.indexOf('--profile')
  const explicit = profileIndex >= 0 ? argv[profileIndex + 1]?.trim() : undefined
  if (explicit !== undefined && /^[a-zA-Z0-9_-]+$/.test(explicit)) return explicit
  if (argv.includes('web')) return 'web'
  return 'web'
}

/** Invoke `dsh plugin add <source>` where source is an npm spec or a local tarball. */
function spawnPluginAdd(
  source: string,
  spawnFn: typeof spawn,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const profile = profileFromProcess(argv, env)
  const command = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const child = spawnFn(command, ['plugin', '--profile', profile, 'add', source], {
    shell: process.platform === 'win32',
    stdio: 'ignore',
  }) as ChildProcess
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(signal === null ? `plugin update exited with code ${code ?? 'unknown'}` : `plugin update terminated by ${signal}`))
    })
  })
}

/**
 * Install an update. When the release carries a `.tgz` asset we download it and
 * install from the local file, so a personal fork works without publishing to
 * npm; otherwise we fall back to the registry spec `@dickpy/dsh-imagegen@<ver>`.
 */
export async function installUpdate(
  version: string,
  downloadUrl: string | undefined,
  spawnFn: typeof spawn = spawn,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('invalid update version')
  }
  if (downloadUrl === undefined || downloadUrl === '') {
    await spawnPluginAdd(`${PACKAGE_NAME}@${version}`, spawnFn, argv, env)
    return
  }
  const response = await fetchFn(downloadUrl, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`release download returned HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error('release download was empty')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-imagegen-update-'))
  const file = join(dir, `${PACKAGE_NAME.replace(/^@/, '').replace(/[\\/]/g, '-')}-${version}.tgz`)
  try {
    await writeFile(file, bytes)
    await spawnPluginAdd(file, spawnFn, argv, env)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Test helper: clear the host-side Release cache. */
export function clearUpdateCache(): void {
  cached = undefined
}
