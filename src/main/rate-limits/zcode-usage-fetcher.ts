import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const API_TIMEOUT_MS = 15_000
const SUPPORTED_HOSTS = new Set(['api.z.ai', 'open.bigmodel.cn', 'dev.bigmodel.cn'])
const CREDENTIAL_IDENTITY_KEY = randomBytes(32)

type ZcodeProviderOptions = {
  apiKey?: unknown
  baseURL?: unknown
}

type ZcodeConfig = {
  model?: string | { main?: unknown }
  provider?: Record<string, { options?: ZcodeProviderOptions }>
}

type QuotaLimit = {
  type?: unknown
  unit?: unknown
  number?: unknown
  usage?: unknown
  currentValue?: unknown
  remaining?: unknown
  percentage?: unknown
  nextResetTime?: unknown
}

type QuotaResponse = {
  success?: unknown
  code?: unknown
  msg?: unknown
  data?: {
    level?: unknown
    limits?: unknown
  }
}

type ZcodeUsageCredentials = {
  apiKey: string
  quotaUrl: string
  authProvenance: string
}

function unavailable(error: string): ProviderRateLimits {
  return {
    provider: 'zcode',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: { source: 'web', failureKind: 'missing-credentials' }
  }
}

function failed(
  error: string,
  failureKind: 'network' | 'server' | 'parse',
  authProvenance: string
): ProviderRateLimits {
  return {
    provider: 'zcode',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { source: 'web', failureKind, authProvenance }
  }
}

function readCredentials(configPath: string): ZcodeUsageCredentials | null {
  let config: ZcodeConfig
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as ZcodeConfig
  } catch {
    return null
  }

  const mainModel = typeof config.model === 'string' ? config.model : config.model?.main
  const delimiter = typeof mainModel === 'string' ? mainModel.indexOf('/') : -1
  const mainProvider =
    typeof mainModel === 'string' && delimiter > 0 && delimiter < mainModel.length - 1
      ? mainModel.slice(0, delimiter)
      : null
  // A quota from another configured account must never appear as the selected model's quota.
  if (!mainProvider) {
    return null
  }
  const provider = config.provider?.[mainProvider]
  if (!provider) {
    return null
  }
  const apiKey = provider.options?.apiKey
  const baseURL = provider.options?.baseURL
  if (
    typeof apiKey !== 'string' ||
    !apiKey.trim() ||
    /[\r\n]/.test(apiKey) ||
    typeof baseURL !== 'string'
  ) {
    return null
  }
  try {
    const parsed = new URL(baseURL)
    if (
      parsed.protocol !== 'https:' ||
      !SUPPORTED_HOSTS.has(parsed.hostname) ||
      (parsed.port !== '' && parsed.port !== '443')
    ) {
      return null
    }
    return {
      apiKey: apiKey.trim(),
      quotaUrl: `${parsed.origin}/api/monitor/usage/quota/limit`,
      authProvenance: createHmac('sha256', CREDENTIAL_IDENTITY_KEY)
        .update(JSON.stringify([mainProvider, parsed.origin, apiKey.trim()]))
        .digest('hex')
    }
  } catch {
    return null
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asUsedPercent(limit: QuotaLimit): number | null {
  const total = asNumber(limit.usage)
  if (total !== null && total > 0) {
    const current = asNumber(limit.currentValue)
    const remaining = asNumber(limit.remaining)
    if (current !== null || remaining !== null) {
      const used = current ?? total - (remaining ?? 0)
      return Math.min(100, Math.max(0, (used / total) * 100))
    }
  }
  const reported = asNumber(limit.percentage)
  return reported === null ? null : Math.min(100, Math.max(0, reported))
}

function asResetTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function asWindowMinutes(limit: QuotaLimit): number | null {
  if (limit.type === 'TIME_LIMIT' && limit.unit === 5 && limit.number === 1) {
    // Z.ai's monthly MCP marker is encoded as one minute.
    return 30 * 24 * 60
  }
  const multipliers: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 }
  const unit = asNumber(limit.unit)
  const count = asNumber(limit.number)
  if (unit === null || count === null || !Number.isInteger(count) || count <= 0) {
    return null
  }
  const multiplier = multipliers[unit]
  return multiplier ? count * multiplier : null
}

function asWindow(limit: QuotaLimit | undefined): RateLimitWindow | null {
  if (!limit) {
    return null
  }
  const usedPercent = asUsedPercent(limit)
  const windowMinutes = asWindowMinutes(limit)
  if (usedPercent === null || windowMinutes === null) {
    return null
  }
  const reset = asResetTime(limit.nextResetTime)
  return {
    usedPercent,
    windowMinutes,
    resetsAt:
      windowMinutes === 300 && reset !== null && reset > Date.now() + 301 * 60_000 ? null : reset,
    resetDescription: null
  }
}

export async function fetchZcodeRateLimits(
  options: {
    configPath?: string
    signal?: AbortSignal
  } = {}
): Promise<ProviderRateLimits> {
  const configPath = options.configPath ?? join(homedir(), '.zcode', 'cli', 'config.json')
  const credentials = readCredentials(configPath)
  if (!credentials) {
    return unavailable('ZCode Coding Plan credentials are not configured')
  }

  let response: Response
  try {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    response = await fetch(credentials.quotaUrl, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: credentials.apiKey,
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json'
      },
      signal
    })
  } catch (error) {
    return failed(
      error instanceof Error ? error.message : 'ZCode quota request failed',
      'network',
      credentials.authProvenance
    )
  }

  if (!response.ok) {
    return failed(
      `ZCode quota request failed (${response.status})`,
      'server',
      credentials.authProvenance
    )
  }

  let payload: QuotaResponse
  try {
    payload = (await response.json()) as QuotaResponse
  } catch {
    return failed('Could not parse ZCode quota response', 'parse', credentials.authProvenance)
  }
  if (
    payload.success !== true ||
    (payload.code !== undefined && payload.code !== 0 && payload.code !== 200) ||
    !Array.isArray(payload.data?.limits)
  ) {
    const message = typeof payload.msg === 'string' ? payload.msg : 'Invalid ZCode quota response'
    return failed(message, 'parse', credentials.authProvenance)
  }

  const limits = payload.data.limits.filter(
    (value): value is QuotaLimit => typeof value === 'object' && value !== null
  )
  const planLimits = limits
    .filter((limit) => limit.type === 'TOKENS_LIMIT' || limit.type === 'CREDIT_LIMIT')
    .map(asWindow)
    .filter((limit): limit is RateLimitWindow => limit !== null)
    .sort((left, right) => left.windowMinutes - right.windowMinutes)
  const session = planLimits.find((limit) => limit.windowMinutes === 300) ?? null
  const weekly = planLimits.find((limit) => limit.windowMinutes === 10080) ?? null
  const monthly = asWindow(limits.find((limit) => limit.type === 'TIME_LIMIT'))
  if (!session && !weekly && !monthly) {
    return failed(
      'ZCode quota response contained no usable limits',
      'parse',
      credentials.authProvenance
    )
  }

  return {
    provider: 'zcode',
    session,
    weekly,
    monthly,
    planType: typeof payload.data.level === 'string' ? payload.data.level : null,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'web',
      credentialSource: configPath,
      authProvenance: credentials.authProvenance
    }
  }
}
