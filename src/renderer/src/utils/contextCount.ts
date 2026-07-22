import { DEFAULT_CONTEXTCOUNT, MAX_CONTEXT_COUNT, UNLIMITED_CONTEXT_COUNT } from '@renderer/config/constant'

export function sanitizeContextCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONTEXTCOUNT
  return Math.min(Math.max(Math.trunc(value), 0), Number.MAX_SAFE_INTEGER)
}

export function isValidContextCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function resolveContextCount(value: unknown): number {
  const contextCount = sanitizeContextCount(value)
  return contextCount === MAX_CONTEXT_COUNT ? UNLIMITED_CONTEXT_COUNT : contextCount
}
