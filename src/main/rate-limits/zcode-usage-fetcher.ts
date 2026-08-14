import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const API_TIMEOUT_MS = 15_000
const SUPPORTED_HOSTS = new Set(['api.z.ai', 'open.bigmodel.cn', 'dev.bigmodel.cn'])

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

function failed(error: string, failureKind: 'network' | 'server' | 'parse'): ProviderRateLimits {
  return {
    provider: 'zcode',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { source: 'web', failureKind }
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
  const mainProvider = typeof mainModel === 'string' ? mainModel.split('/', 1)[0] : null
  // A quota from another configured account must never appear as the selected model's quota.
  const candidates = mainProvider
    ? Object.entries(config.provider ?? {}).filter(([id]) => id === mainProvider)
    : Object.entries(config.provider ?? {})
  if (!mainProvider && candidates.length !== 1) {
    return null
  }

  for (const [, provider] of candidates) {
    const apiKey = provider.options?.apiKey
    const baseURL = provider.options?.baseURL
    if (
      typeof apiKey !== 'string' ||
      !apiKey.trim() ||
      /[\r\n]/.test(apiKey) ||
      typeof baseURL !== 'string'
    ) {
      continue
    }
    try {
      const parsed = new URL(baseURL)
      if (
        parsed.protocol !== 'https:' ||
        !SUPPORTED_HOSTS.has(parsed.hostname) ||
        (parsed.port !== '' && parsed.port !== '443')
      ) {
        continue
      }
      return {
        apiKey: apiKey.trim(),
        quotaUrl: `${parsed.origin}/api/monitor/usage/quota/limit`
      }
    } catch {
      continue
    }
  }
  return null
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
  return {
    usedPercent,
    windowMinutes,
    resetsAt: asResetTime(limit.nextResetTime),
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
    return failed(error instanceof Error ? error.message : 'ZCode quota request failed', 'network')
  }

  if (!response.ok) {
    return failed(`ZCode quota request failed (${response.status})`, 'server')
  }

  let payload: QuotaResponse
  try {
    payload = (await response.json()) as QuotaResponse
  } catch {
    return failed('Could not parse ZCode quota response', 'parse')
  }
  if (
    payload.success !== true ||
    (payload.code !== undefined && payload.code !== 0 && payload.code !== 200) ||
    !Array.isArray(payload.data?.limits)
  ) {
    const message = typeof payload.msg === 'string' ? payload.msg : 'Invalid ZCode quota response'
    return failed(message, 'parse')
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
    return failed('ZCode quota response contained no usable limits', 'parse')
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
    usageMetadata: { source: 'web', credentialSource: configPath }
  }
}
