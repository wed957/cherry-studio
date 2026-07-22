import { DEFAULT_CONTEXTCOUNT, MAX_CONTEXT_COUNT } from '@renderer/config/constant'
import { isValidContextCount, resolveContextCount, sanitizeContextCount } from '@renderer/utils/contextCount'
import { describe, expect, it } from 'vitest'

describe('contextCount', () => {
  it('保留有效的非负整数，并清理异常存储值', () => {
    expect(sanitizeContextCount(0)).toBe(0)
    expect(sanitizeContextCount(999)).toBe(999)
    expect(sanitizeContextCount(12.9)).toBe(12)
    expect(sanitizeContextCount(-1)).toBe(0)
    expect(sanitizeContextCount(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CONTEXTCOUNT)
    expect(sanitizeContextCount('999')).toBe(DEFAULT_CONTEXTCOUNT)
    expect(isValidContextCount(999999)).toBe(true)
    expect(isValidContextCount(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(isValidContextCount(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isValidContextCount(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
    expect(isValidContextCount(-1)).toBe(false)
  })

  it('只把 100 哨兵转换为真正的全量上下文', () => {
    expect(resolveContextCount(MAX_CONTEXT_COUNT)).toBe(Number.MAX_SAFE_INTEGER)
    expect(resolveContextCount(MAX_CONTEXT_COUNT + 1)).toBe(MAX_CONTEXT_COUNT + 1)
  })
})
