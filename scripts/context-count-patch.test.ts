import { describe, expect, it } from 'vitest'

import { patchContextCountSource } from './context-count-patch'

describe('context-count-patch', () => {
  it('只移除上下文输入框的 max，不修改 Slider 或其他数字输入框', () => {
    const source = `
      <EditableNumber min={0} max={MAX_CONTEXT_COUNT} value={contextCount} />
      <Slider min={0} max={MAX_CONTEXT_COUNT} value={contextCount} />
      <InputNumber min={0} max={20} value={temperature} />
      <InputNumber
        min={0}
        max={20}
        value={contextCount}
        onChange={onContextCountChange}
      />
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(2)
    expect(result.content).toContain('<Slider min={0} max={MAX_CONTEXT_COUNT} value={contextCount} />')
    expect(result.content).toContain('<InputNumber min={0} max={20} value={temperature} />')
    expect(result.content).not.toContain('<EditableNumber min={0} max={MAX_CONTEXT_COUNT}')
    expect(result.content).not.toContain('max={20}\n        value={contextCount}')
  })

  it('重复执行是幂等的，并支持字符串属性值', () => {
    const source = `<InputNumber max="20" value={contextCount} />`
    const once = patchContextCountSource(source)
    const twice = patchContextCountSource(once.content)

    expect(once.changed).toBe(1)
    expect(twice.changed).toBe(0)
    expect(twice.content).toBe(once.content)
  })

  it('只处理 JSX 顶层 max，不误删嵌套表达式、注释或字符串中的 max', () => {
    const source = `
      <InputNumber
        value={contextCount}
        max={40}
        formatter={(max = 20) => max}
        onChange={() => { max = 30 }}
        aria-label="max=50"
        {/* max={60} */}
      />
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(1)
    expect(result.content).not.toContain('max={40}')
    expect(result.content).toContain('formatter={(max = 20) => max}')
    expect(result.content).toContain('onChange={() => { max = 30 }}')
    expect(result.content).toContain('aria-label="max=50"')
    expect(result.content).toContain('{/* max={60} */}')
  })

  it('在字符串包含非 BMP 字符时仍保持编辑偏移正确', () => {
    const source = `<InputNumber title="${'😀'.repeat(50)}" value={contextCount} max={20} />`

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(1)
    expect(result.content).not.toContain('max={20}')
    expect(result.content).toContain(`title="${'😀'.repeat(50)}"`)
  })
})
