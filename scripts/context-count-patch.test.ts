import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { patchContextCountSource, run } from './context-count-patch'

const temporaryDirectories: string[] = []

function createFixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-count-patch-'))
  temporaryDirectories.push(root)
  for (const [fileName, content] of Object.entries(files)) {
    const filePath = path.join(root, fileName)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf8')
  }
  return root
}

const editableNumberSettings = `
  import EditableNumber from '@renderer/components/EditableNumber'
  import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
  import { useState } from 'react'

  const View = ({ settings }) => {
    const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
    return <EditableNumber value={contextCount} max={20} />
  }
`

const healthyEditableNumber = `
  import { InputNumber } from 'antd'

  const EditableNumber = ({ value, max, onChange }) => {
    const handleChange = (newValue) => onChange?.(newValue ?? null)
    return <InputNumber value={value} max={max} onChange={handleChange} />
  }
  export default EditableNumber
`

function createEditableNumberFixture(
  implementation: string,
  settings = editableNumberSettings,
  extraFiles: Record<string, string> = {}
): string {
  return createFixture({
    ...extraFiles,
    'Settings.tsx': settings,
    'components/EditableNumber/index.tsx': implementation
  })
}

function expectEditableNumberContractFailure(implementation: string): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const root = createEditableNumberFixture(implementation)
  const settingsPath = path.join(root, 'Settings.tsx')
  const original = fs.readFileSync(settingsPath, 'utf8')

  expect(() => run({ root, write: true, requireTargets: true, expectedTargets: 1, expectedSliders: 0 })).toThrow()
  expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original)
}

const healthyContextGuard = `
  export function isValidContextCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  }
`

afterEach(() => {
  vi.restoreAllMocks()
  while (temporaryDirectories.length > 0) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
})

it.each([
  [
    '重复 JSX value 属性',
    `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, max, onChange }) => {
          const handleChange = (newValue) => onChange?.(newValue ?? null)
          return <InputNumber value={value} value={value} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
  ],
  [
    '镜像解构包含额外元素',
    `
        import { InputNumber } from 'antd'
        import { useEffect, useState } from 'react'
        const EditableNumber = ({ value, max, onChange }) => {
          const [inputValue, setInputValue, extra] = useState(value)
          useEffect(() => setInputValue(value), [value])
          const handleChange = (newValue) => onChange?.(newValue ?? null)
          return <InputNumber value={inputValue} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
  ]
])('EditableNumber %s 时拒绝不明确的绑定结构', (_name, implementation) => {
  expectEditableNumberContractFailure(implementation)
})

describe('context-count-patch', () => {
  it('只移除上下文数字输入框的 max，不修改 Slider 或其他数字输入框', () => {
    const source = `
      import { InputNumber, InputNumber as EditableNumber, Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'

      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <>
          <EditableNumber min={0} max={MAX_CONTEXT_COUNT} value={contextCount} />
          <Slider min={0} max={MAX_CONTEXT_COUNT} value={contextCount} onChange={setContextCount} />
          <InputNumber min={0} max={20} value={temperature} />
          <InputNumber
            min={0}
            max={20}
            value={contextCount}
          />
        </>
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(2)
    expect(result.candidates).toHaveLength(2)
    expect(result.ignoredSliders).toEqual([
      expect.objectContaining({ component: 'Slider', hasMax: true, reason: 'import:Slider as Slider' })
    ])
    expect(result.content).toContain(
      '<Slider min={0} max={MAX_CONTEXT_COUNT} value={contextCount} onChange={setContextCount} />'
    )
    expect(result.content).toContain('<InputNumber min={0} max={20} value={temperature} />')
    expect(result.content).not.toContain('<EditableNumber min={0} max={MAX_CONTEXT_COUNT}')
    expect(result.content).not.toContain('max={20}\n            value={contextCount}')
  })

  it('支持属性换序、导入别名、命名空间和多层本地包装组件', () => {
    const source = `
      import { InputNumber as AntCount, Slider as AntRange } from 'antd'
      import * as Antd from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { memo, useState } from 'react'
      import styled from 'styled-components'

      const StyledCount = styled(AntCount)
      const MemoCount = memo(StyledCount)
      const FunctionCount = (props) => <Antd.InputNumber {...props} />
      const WrappedRange = styled(AntRange)
      const InputNumber = styled(AntRange)

      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <>
          <AntCount value={contextCount} max={20} min={0} />
          <Antd.InputNumber max={20} value={contextCount} />
          <MemoCount value={contextCount} max={20} />
          <FunctionCount max={20} value={contextCount} />
          <WrappedRange value={contextCount} max={20} onChange={setContextCount} />
          <InputNumber value={contextCount} max={20} onChange={setContextCount} />
        </>
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(4)
    expect(result.candidates.map((candidate) => candidate.component)).toEqual([
      'AntCount',
      'Antd.InputNumber',
      'MemoCount',
      'FunctionCount'
    ])
    expect(result.candidates.every((candidate) => candidate.line > 0 && candidate.column > 0)).toBe(true)
    expect(result.candidates.map((candidate) => candidate.resolution)).toEqual([
      expect.stringContaining('import:InputNumber as AntCount'),
      'namespace:Antd.InputNumber',
      expect.stringContaining('wrapper:MemoCount'),
      expect.stringContaining('wrapper:FunctionCount')
    ])
    expect(result.ignoredSliders).toEqual([
      expect.objectContaining({ component: 'WrappedRange', hasMax: true, reason: expect.stringContaining('Slider') }),
      expect.objectContaining({ component: 'InputNumber', hasMax: true, reason: expect.stringContaining('Slider') })
    ])
    expect(result.content).toContain('<WrappedRange value={contextCount} max={20} onChange={setContextCount} />')
    expect(result.content).toContain('<InputNumber value={contextCount} max={20} onChange={setContextCount} />')
  })

  it('只有通过 EditableNumber 健康契约的默认导入才会在 run 中获信任', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const root = createEditableNumberFixture(healthyEditableNumber)

    const result = run({ root, write: true, requireTargets: true, expectedTargets: 1, expectedSliders: 0 })

    expect(result).toEqual(
      expect.objectContaining({ files: 1, candidates: 1, changed: 1, ignoredSliders: 0, diagnostics: [] })
    )
    expect(fs.readFileSync(path.join(root, 'Settings.tsx'), 'utf8')).toContain(
      '<EditableNumber value={contextCount} />'
    )
    expect(fs.readFileSync(path.join(root, 'components/EditableNumber/index.tsx'), 'utf8')).toBe(healthyEditableNumber)
  })

  it.each([
    [
      '同级 flat 文件 shadow',
      {
        'components/EditableNumber.tsx': healthyEditableNumber
      }
    ],
    [
      'tsconfig paths 漂移',
      {
        'shadow/EditableNumber.tsx': healthyEditableNumber,
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            paths: { '@renderer/components/EditableNumber': ['./shadow/EditableNumber.tsx'], '@renderer/*': ['*'] }
          }
        })
      }
    ]
  ])('EditableNumber 发生%s时按实际模块解析安全失败', (_caseName, extraFiles) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const root = createEditableNumberFixture(healthyEditableNumber, editableNumberSettings, extraFiles)

    expect(() => run({ root, write: true, requireTargets: true, expectedTargets: 1, expectedSliders: 0 })).toThrow(
      'TRUSTED_MODULE_RESOLUTION'
    )
    expect(fs.readFileSync(path.join(root, 'Settings.tsx'), 'utf8')).toBe(editableNumberSettings)
  })

  it('不会读取外部 tsconfig extends，解析只使用当前配置显式声明的路径', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const root = createEditableNumberFixture(healthyEditableNumber, editableNumberSettings, {
      'tsconfig.json': JSON.stringify({
        extends: '@uninstalled/untrusted-config',
        compilerOptions: {
          baseUrl: '.',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          paths: { '@renderer/*': ['*'] }
        }
      })
    })

    const result = run({ root, write: true, requireTargets: true, expectedTargets: 1, expectedSliders: 0 })

    expect(result.changed).toBe(1)
    expect(fs.readFileSync(path.join(root, 'Settings.tsx'), 'utf8')).toContain(
      '<EditableNumber value={contextCount} />'
    )
  })

  it('相对 tsconfig extends 会 fail-closed，避免解析候选树外的配置', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const root = createEditableNumberFixture(healthyEditableNumber, editableNumberSettings, {
      'base.json': JSON.stringify({ compilerOptions: { paths: { '@renderer/*': ['shadow/*'] } } }),
      'tsconfig.json': JSON.stringify({
        extends: './base.json',
        compilerOptions: {
          baseUrl: '.',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          paths: { '@renderer/*': ['*'] }
        }
      })
    })

    expect(() => run({ root, write: true, requireTargets: true, expectedTargets: 1, expectedSliders: 0 })).toThrow(
      'TRUSTED_MODULE_RESOLUTION'
    )
    expect(fs.readFileSync(path.join(root, 'Settings.tsx'), 'utf8')).toBe(editableNumberSettings)
  })

  it('可信模块的父目录经过 symlink 或 junction 时拒绝继续解析', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const root = createFixture({
      'Settings.tsx': editableNumberSettings,
      'trusted-target/EditableNumber/index.tsx': healthyEditableNumber
    })
    const componentsPath = path.join(root, 'components')
    const targetPath = path.join(root, 'trusted-target')
    try {
      fs.symlinkSync(targetPath, componentsPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      // 某些受限工作站禁用链接创建；这不是补丁器契约的失败，跳过环境能力测试。
      if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES')
        return
      throw error
    }

    expect(() => run({ root, write: true, requireTargets: true, expectedTargets: 1, expectedSliders: 0 })).toThrow(
      'TRUSTED_MODULE_RESOLUTION'
    )
    expect(fs.readFileSync(path.join(root, 'Settings.tsx'), 'utf8')).toBe(editableNumberSettings)
  })

  it('单文件解析不会因伪造受信模块导入而认可 EditableNumber', () => {
    const source = `
      import EditableNumber from '@renderer/components/EditableNumber'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <EditableNumber value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_COMPONENT' })])
  })

  it('不会仅凭跨文件导入名猜测 ContextNumberField 是数字输入组件', () => {
    const source = `
      import ContextNumberField from './ContextNumberField'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <ContextNumberField value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_COMPONENT' })])
  })

  it.each([
    [
      '固定 max',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value }) => <InputNumber value={value} max={20} />
        export default EditableNumber
      `,
      'max 必须直接绑定到参数 max'
    ],
    [
      '直接默认导出 Slider',
      `
        import { Slider } from 'antd'
        export default Slider
      `,
      'export default 不是可静态检查的函数组件'
    ],
    [
      '伪造 InputNumber 导入',
      `
        import { InputNumber } from './decoy'
        const EditableNumber = ({ value, max }) => <InputNumber value={value} max={max} />
        export default EditableNumber
      `,
      '必须只包含一个来自 antd 的 InputNumber，当前发现 0 个'
    ],
    [
      'helper 内固定 max',
      `
        import { InputNumber } from 'antd'
        const Hidden = ({ value }) => <InputNumber value={value} max={20} />
        const EditableNumber = ({ value, max, useHidden }) => (
          useHidden ? <Hidden value={value} /> : <InputNumber value={value} max={max} />
        )
        export default EditableNumber
      `,
      '返回路径包含可能隐藏 max 的本地包装组件'
    ],
    [
      'render helper 内固定 max',
      `
        import { InputNumber } from 'antd'
        const renderHidden = (value) => <InputNumber value={value} max={20} />
        const EditableNumber = ({ value, max, useHidden }) => (
          useHidden ? renderHidden(value) : <InputNumber value={value} max={max} />
        )
        export default EditableNumber
      `,
      '返回路径包含未解析的 render helper 或 JSX 值'
    ],
    [
      'JSX 常量内固定 max',
      `
        import { InputNumber } from 'antd'
        const hidden = <InputNumber value={0} max={20} />
        const EditableNumber = ({ value, max, useHidden }) => (
          useHidden ? hidden : <InputNumber value={value} max={max} />
        )
        export default EditableNumber
      `,
      '返回路径包含未解析的 render helper 或 JSX 值'
    ],
    [
      'imported 组件隐藏 max',
      `
        import { InputNumber } from 'antd'
        import Hidden from './Hidden'
        const EditableNumber = ({ value, max }) => <>
          <InputNumber value={value} max={max} />
          <Hidden value={value} />
        </>
        export default EditableNumber
      `,
      '返回树包含无法证明安全的组件 Hidden'
    ],
    [
      'JSX child 调用 imported render helper',
      `
        import { InputNumber } from 'antd'
        import { renderHidden } from './hidden'
        const EditableNumber = ({ value, max, enabled }) => <>
          <InputNumber value={value} max={max} />
          {enabled && renderHidden(value)}
        </>
        export default EditableNumber
      `,
      '返回路径包含未解析的 render helper 或 JSX 值'
    ],
    [
      'JSX child 使用 imported JSX 值',
      `
        import { InputNumber } from 'antd'
        import { hidden } from './hidden'
        const EditableNumber = ({ value, max, enabled }) => <>
          <InputNumber value={value} max={max} />
          {enabled && hidden}
        </>
        export default EditableNumber
      `,
      '返回路径包含未解析的 render helper 或 JSX 值'
    ],
    [
      'JSX child 使用 imported 成员 JSX 值',
      `
        import { InputNumber } from 'antd'
        import * as hiddenValues from './hidden'
        const EditableNumber = ({ value, max, enabled }) => <>
          <InputNumber value={value} max={max} />
          {enabled && hiddenValues.node}
        </>
        export default EditableNumber
      `,
      '返回路径包含未解析的 render helper 或 JSX 值'
    ],
    [
      'JSX child 通过逗号表达式调用 imported helper',
      `
        import { InputNumber } from 'antd'
        import { renderHidden } from './hidden'
        const EditableNumber = ({ value, max, enabled }) => <>
          <InputNumber value={value} max={max} />
          {enabled && (0, renderHidden(value))}
        </>
        export default EditableNumber
      `,
      '返回路径包含未解析的 render helper 或 JSX 值'
    ],
    [
      '返回树含 Slider sibling',
      `
        import { InputNumber, Slider } from 'antd'
        const EditableNumber = ({ value, max }) => <>
          <InputNumber value={value} max={max} />
          <Slider value={value} />
        </>
        export default EditableNumber
      `,
      '返回树包含额外 Slider、max 或 spread 分支'
    ],
    [
      'InputNumber 含 spread',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, max, ...rest }) => (
          <InputNumber value={value} max={max} {...rest} />
        )
        export default EditableNumber
      `,
      'InputNumber 不能使用 spread'
    ],
    [
      'InputNumber 含 parser 限幅',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, max }) => (
          <InputNumber value={value} max={max} parser={(raw) => String(Math.min(Number(raw), 20))} />
        )
        export default EditableNumber
      `,
      '不能声明 parser'
    ],
    [
      '内部 state 初始化限幅',
      `
        import { InputNumber } from 'antd'
        import { useState } from 'react'
        const EditableNumber = ({ value, max }) => {
          const [inputValue] = useState(Math.min(value ?? 0, 20))
          return <InputNumber value={inputValue} max={max} />
        }
        export default EditableNumber
      `,
      'value 必须直接来自 value 参数或 useState(value) 镜像'
    ],
    [
      'effect 写入镜像 state 时限幅',
      `
        import { InputNumber } from 'antd'
        import { useEffect, useState } from 'react'
        const EditableNumber = ({ value, max }) => {
          const [inputValue, setInputValue] = useState(value)
          useEffect(() => setInputValue(Math.min(value ?? 0, 20)), [value])
          return <InputNumber value={inputValue} max={max} />
        }
        export default EditableNumber
      `,
      'value 或内部镜像 state 存在条件、算术或限幅调用'
    ],
    [
      'onChange 转发时限幅',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, max, onChange }) => {
          const handleChange = (newValue) => onChange?.(Math.min(newValue ?? 0, 20))
          return <InputNumber value={value} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `,
      'onChange 参数在原样转发前使用了不透明 helper、别名或异步控制流'
    ],
    [
      'onBlur 从 value 恢复有限上界',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, max, onChange }) => (
          <InputNumber value={value} max={max} onBlur={() => onChange?.(Math.min(value ?? 0, 20))} />
        )
        export default EditableNumber
      `,
      'value 或内部镜像 state 存在条件、算术或限幅调用'
    ],
    [
      'InputNumber 缺少 onChange',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, max, onChange }) => <InputNumber value={value} max={max} />
        export default EditableNumber
      `,
      'InputNumber 必须声明唯一的 onChange 透明转发'
    ],
    [
      'onChange 参数在 effect 中被额外调用',
      `
        import { InputNumber } from 'antd'
        import { useEffect } from 'react'
        const EditableNumber = ({ value, max, onChange }) => {
          const handleChange = (newValue) => onChange?.(newValue ?? null)
          useEffect(() => onChange?.(20), [value])
          return <InputNumber value={value} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `,
      'onChange 参数只能在 InputNumber handler 中恰好一次原样转发回调值'
    ],
    [
      'useState(value) 镜像没有上游同步 effect',
      `
        import { InputNumber } from 'antd'
        import { useState } from 'react'
        const EditableNumber = ({ value, max, onChange }) => {
          const [inputValue, setInputValue] = useState(value)
          const handleChange = (newValue) => onChange?.(newValue ?? null)
          return <InputNumber value={inputValue} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `,
      'useState(value) 镜像必须通过依赖 value 的 effect 原样同步 setter'
    ]
  ])('EditableNumber %s 时跨文件健康契约失败且不写入', (_caseName, implementation, expectedMessage) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const root = createEditableNumberFixture(implementation)
    const original = fs.readFileSync(path.join(root, 'Settings.tsx'), 'utf8')

    expect(() => run({ root, write: true, requireTargets: true, expectedTargets: 1, expectedSliders: 0 })).toThrow(
      expectedMessage
    )
    expect(fs.readFileSync(path.join(root, 'Settings.tsx'), 'utf8')).toBe(original)
  })

  it('重复执行幂等，并支持 contextCount 的本地别名', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const count = contextCount
        return <InputNumber max="20" value={count} />
      }
    `
    const once = patchContextCountSource(source)
    const twice = patchContextCountSource(once.content)

    expect(once.changed).toBe(1)
    expect(once.candidates[0]).toEqual(expect.objectContaining({ valueExpression: 'count', maxCount: 1 }))
    expect(twice.changed).toBe(0)
    expect(twice.content).toBe(once.content)
  })

  it('只信任来源明确且形状严格的 useState<number> contextCount', () => {
    const source = `
      import { InputNumber as AntInputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'

      const NumericInitial = () => {
        const [contextCount] = useState<number>(20)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const BareProperty = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const BareDefault = () => {
        const [contextCount] = useState<number>(DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const ObjectInitial = () => {
        const [contextCount] = useState<number>({ contextCount: DEFAULT_CONTEXTCOUNT })
        return <AntInputNumber value={contextCount} max={20} />
      }
      const CallInitial = () => {
        const [contextCount] = useState<number>(loadContextCount())
        return <AntInputNumber value={contextCount} max={20} />
      }
      const ConditionalInitial = ({ settings }) => {
        const [contextCount] = useState<number>(enabled ? settings.contextCount : DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const AnyState = ({ settings }) => {
        const [contextCount] = useState<any>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const AssertedInitial = ({ settings }) => {
        const [contextCount] = useState<number>((settings.contextCount ?? DEFAULT_CONTEXTCOUNT) as number)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const LocalHook = ({ settings }) => {
        const useState = fakeUseState
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const LocalDefault = ({ settings }) => {
        const DEFAULT_CONTEXTCOUNT = 20
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const FakeRoot = ({ fake }) => {
        const [contextCount] = useState<number>(fake.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const FakeNestedRoot = ({ fake }) => {
        const [contextCount] = useState<number>(fake.settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const LocalAssistant = () => {
        const assistant = { settings: { contextCount: 20 } }
        const [contextCount] = useState<number>(assistant.settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const LocalSettings = () => {
        const settings = { contextCount: 20 }
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const CallRoot = () => {
        const [contextCount] = useState<number>(getFake().settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const MutableParameter = ({ assistant }) => {
        assistant = getFakeAssistant()
        const [contextCount] = useState<number>(assistant.settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const AliasedSettingsMutation = ({ settings }) => {
        const alias = settings
        alias.contextCount = temperature
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
      const EscapedSettings = ({ settings }) => {
        mutateSettings(settings)
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics).toEqual([])
    expect(result.content).toBe(source)
  })

  it('只接受真实 assistant 参数和受信 useDefaultAssistant 返回值', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useDefaultAssistant as useTrustedDefaultAssistant } from '@renderer/hooks/useAssistant'
      import { useState } from 'react'

      const AssistantView = ({ assistant }) => {
        const [contextCount] = useState<number>(assistant?.settings?.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber value={contextCount} max={20} />
      }
      const DefaultAssistantView = () => {
        const { defaultAssistant } = useTrustedDefaultAssistant()
        const [contextCount] = useState<number>(defaultAssistant.settings?.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber value={contextCount} max={20} />
      }
      const ForgedDefaultAssistantView = () => {
        const { defaultAssistant } = getFakeAssistantState()
        const [contextCount] = useState<number>(defaultAssistant.settings?.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber value={contextCount} max={20} />
      }
      const MutatedDefaultAssistantView = () => {
        const { defaultAssistant } = useTrustedDefaultAssistant()
        defaultAssistant.settings = { contextCount: 20 }
        const [contextCount] = useState<number>(defaultAssistant.settings?.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber value={contextCount} max={20} />
      }
      const ReassignedDefaultAssistantView = () => {
        const { defaultAssistant } = useTrustedDefaultAssistant()
        defaultAssistant = getFakeAssistant()
        const [contextCount] = useState<number>(defaultAssistant.settings?.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber value={contextCount} max={20} />
      }
      const AliasedDefaultAssistantView = () => {
        const { defaultAssistant } = useTrustedDefaultAssistant()
        const alias = defaultAssistant
        alias.settings.contextCount = 20
        const [contextCount] = useState<number>(defaultAssistant.settings?.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber value={contextCount} max={20} />
      }
      const EscapedDefaultAssistantView = () => {
        const { defaultAssistant } = useTrustedDefaultAssistant()
        mutateAssistant(defaultAssistant)
        const [contextCount] = useState<number>(defaultAssistant.settings?.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(2)
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.map((candidate) => candidate.component)).toEqual(['InputNumber', 'InputNumber'])
    expect(result.content.match(/<InputNumber value=\{contextCount\} \/>/gu)).toHaveLength(2)
    expect(result.content.match(/<InputNumber value=\{contextCount\} max=\{20\} \/>/gu)).toHaveLength(5)
  })

  it('未绑定的 contextCount 和 InputNumber 不会仅凭名称触发补丁', () => {
    const source = `const View = () => <InputNumber value={contextCount} max={20} />`

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics).toEqual([])
    expect(result.content).toBe(source)
  })

  it('按词法作用域解析只读标量别名，不跨函数误用遮蔽或复合值', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const rootCount = contextCount
        let mutableCount = contextCount
        const Valid = () => <InputNumber value={rootCount} max={20} />
        const Shadowed = (rootCount) => <InputNumber value={rootCount} max={20} />
        const ParameterShadow = (contextCount) => <InputNumber value={contextCount} max={20} />
        const CompoundShadow = () => {
          const contextCount = { count: 20 }
          return <InputNumber value={contextCount} max={20} />
        }
        const Mutable = () => <InputNumber value={mutableCount} max={20} />
        return <Valid />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(1)
    expect(result.candidates).toEqual([
      expect.objectContaining({ component: 'InputNumber', valueExpression: 'rootCount' })
    ])
    expect(result.content).toContain('<InputNumber value={rootCount} />')
    expect(result.content).toContain('<InputNumber value={rootCount} max={20} />')
  })

  it('contextCount 的逻辑取反属于有损变换并安全失败', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <>
          <InputNumber value={!contextCount} max={20} />
          <InputNumber value={!!contextCount} max={20} />
        </>
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics).toHaveLength(2)
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === 'UNRESOLVED_CONTEXT_VALUE')).toBe(true)
    expect(result.content).toBe(source)
  })

  it('contextCount 的条件、取模和算术变换不会被当作无损目标', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <>
          <InputNumber value={contextCount > 20 ? 20 : contextCount} max={20} />
          <InputNumber value={contextCount % 21} max={20} />
          <InputNumber value={contextCount + 1} max={20} />
        </>
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics).toHaveLength(3)
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === 'UNRESOLVED_CONTEXT_VALUE')).toBe(true)
    expect(result.content).toBe(source)
  })

  it('数字输入的 parser、限幅 onChange 与行为 spread 都安全失败', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const limitedChange = (value) => {
          if (value > 20) return
          setContextCount(value)
        }
        return <>
          <InputNumber value={contextCount} max={20} parser={(raw) => String(Math.min(Number(raw), 20))} />
          <InputNumber value={contextCount} max={20} onChange={limitedChange} />
          <InputNumber value={contextCount} max={20} {...{ onChange: setContextCount }} />
        </>
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNRESOLVED_NUMERIC_BEHAVIOR' }),
        expect.objectContaining({ code: 'HIDDEN_CONTEXT_LIMIT' })
      ])
    )
    expect(result.content).toBe(source)
  })

  it('数字输入本地 onChange handler 参数未被修改时允许原样透传', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const handleChange = (value: number) => setContextCount(value)
        return <InputNumber value={contextCount} max={20} onChange={handleChange} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(1)
    expect(result.diagnostics).toEqual([])
    expect(result.content).toContain('<InputNumber value={contextCount} onChange={handleChange} />')
  })

  it.each([
    ['参数重赋', '(value: number) => { value = 20; setContextCount(value) }'],
    ['默认参数', '(value: number = 20) => setContextCount(value)'],
    ['可选参数', '(value?: number) => setContextCount(value)'],
    ['rest 参数', '(...values: number[]) => setContextCount(values[0])'],
    ['额外参数', '(value: number, ignored: number) => setContextCount(value)']
  ])('数字输入本地 onChange handler 使用%s时 fail-closed', (_name, handler) => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const handleChange = ${handler}
        return <InputNumber value={contextCount} max={20} onChange={handleChange} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_NUMERIC_BEHAVIOR' })])
    )
  })

  it.each([
    [
      '未知 helper 校验后写入',
      '(value: number) => { if (looksValid(value)) setContextCount(value) }',
      'HIDDEN_CONTEXT_LIMIT'
    ],
    ['async handler', 'async (value: number) => { setContextCount(value) }', 'HIDDEN_CONTEXT_LIMIT'],
    ['generator handler', 'function* (value: number) { setContextCount(value) }', 'HIDDEN_CONTEXT_LIMIT'],
    ['参数别名后写入', '(value: number) => { const alias = value; setContextCount(value) }', 'HIDDEN_CONTEXT_LIMIT']
  ])('数字输入 onChange 数据流在%s时 fail-closed', (_name, handler, code) => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const handleChange = ${handler}
        return <InputNumber value={contextCount} max={20} onChange={handleChange} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', code })]))
  })

  it('canonical setter 在 effect 中恢复有限上界时整体安全失败', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useEffect, useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        useEffect(() => setContextCount(Math.min(contextCount, 20)), [contextCount])
        return <InputNumber value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'HIDDEN_CONTEXT_LIMIT' })])
  })

  it('unknown 分支会污染条件、二元和数组包装解析', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const Conditional = enabled ? InputNumber : MysteryField
      const Binary = enabled && InputNumber
      const Choices = [InputNumber, MysteryField]
      const ArrayChoice = Choices[index]
      const FunctionConditional = (props) => enabled ? <InputNumber {...props} /> : null
      const FunctionBinary = (props) => enabled && <InputNumber {...props} />
      const FunctionArray = (props) => [<InputNumber {...props} />, fallback]
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <>
          <Conditional value={contextCount} max={20} />
          <Binary value={contextCount} max={20} />
          <ArrayChoice value={contextCount} max={20} />
          <FunctionConditional value={contextCount} max={20} />
          <FunctionBinary value={contextCount} max={20} />
          <FunctionArray value={contextCount} max={20} />
        </>
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toHaveLength(6)
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === 'UNRESOLVED_COMPONENT')).toBe(true)
  })

  it('组件解析遵循词法遮蔽，局部 Slider 别名不会按 import 名称误改', () => {
    const source = `
      import { InputNumber, Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const InputNumber = Slider
        return <InputNumber value={contextCount} max={20} onChange={setContextCount} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.ignoredSliders).toHaveLength(1)
  })

  it('可变组件绑定重赋为 Slider 后不会按初始值误判为数字输入', () => {
    const source = `
      import { InputNumber, Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      let Field = InputNumber
      Field = Slider
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <Field value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_COMPONENT' })])
  })

  it('重复 var 绑定造成 contextCount、Number 或 InputNumber 歧义时不误删', () => {
    const source = `
      import { InputNumber as AntInputNumber, Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'

      const DuplicateContext = () => {
        var contextCount = 1
        var contextCount = 2
        return <AntInputNumber value={contextCount} max={20} />
      }
      const DuplicateNumber = ({ settings }) => {
        var Number = (value) => value
        var Number = (value) => value + 1
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={Number(contextCount)} max={20} />
      }
      const DuplicateInput = ({ settings }) => {
        var InputNumber = AntInputNumber
        var InputNumber = Slider
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_CONTEXT_VALUE' }),
        expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_COMPONENT' })
      ])
    )
  })

  it('局部同名 memo 不会被当作受信 React HOC', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const memo = (Component) => createSlider(Component)
        const Field = memo(InputNumber)
        return <Field value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_COMPONENT' })])
  })

  it('包装器追踪遵循词法绑定，不会修改其他作用域的同名包装器', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const CountField = ({ value }) => <InputNumber value={value} max={99} />
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const CountField = (props) => <InputNumber {...props} />
        return <CountField value={contextCount} max={7} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.diagnostics).toEqual([])
    expect(result.candidates).toHaveLength(1)
    expect(result.changed).toBe(1)
    expect(result.content).toContain('<InputNumber value={value} max={99} />')
    expect(result.content).toContain('<InputNumber {...props} />')
    expect(result.content).toContain('<CountField value={contextCount} />')
  })

  it('命名空间组件解析遵循词法遮蔽，不会仅凭成员名误判', () => {
    const source = `
      import * as Antd from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const Antd = { InputNumber: Slider }
        return <Antd.InputNumber value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'UNRESOLVED_COMPONENT' })])
  })

  it('后置 spread 覆盖 value 时不会把已失效的显式 contextCount 当成目标', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber value={contextCount} {...{ value: temperature }} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.content).toBe(source)
  })

  it('const 对象属性写入后再 spread 时不会信任旧快照', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const props = {}
        props.value = temperature
        return <InputNumber value={contextCount} {...props} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_SPREAD_VALUE' })
    ])
  })

  it('未知 HOC 不会仅凭参数中出现 InputNumber 就被当作数字输入', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const SliderLike = createSlider(InputNumber)
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <SliderLike value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'UNRESOLVED_COMPONENT' })])
  })

  it('catch 同名绑定不会被误认为 canonical contextCount', () => {
    const source = `
      import { InputNumber } from 'antd'
      try { run() } catch (contextCount) {
        render(<InputNumber value={contextCount} max={20} />)
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.content).toBe(source)
  })

  it('共享 wrapper 同时承载 contextCount 和其他值时不会删除内部 max', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const SharedField = ({ value }) => <InputNumber value={value} max={20} />
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <>
          <SharedField value={contextCount} />
          <SharedField value={temperature} />
        </>
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_WRAPPER_MAX' })])
  })

  it('包装器把 max 用于其他逻辑时安全失败而不删除调用点属性', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const Wrapped = ({ value, max }) => {
        audit(max)
        return <InputNumber value={value} max={20} />
      }
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <Wrapped value={contextCount} max={7} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'UNRESOLVED_WRAPPER_MAX' })])
  })

  it('包装参数被闭包中的 audit 使用时安全失败', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const Wrapped = ({ value, max }) => {
        const auditMax = () => audit(max)
        return <InputNumber value={value} max={max} onBlur={auditMax} />
      }
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <Wrapped value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_WRAPPER_MAX' })])
  })

  it('可变 props 与已排除 value 的 rest 不会被当作透明透传', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const Mutating = (props) => {
        props.max = 20
        return <InputNumber {...props} />
      }
      const Rest = ({ value, ...rest }) => <InputNumber {...rest} max={20} />
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <>
          <Mutating value={contextCount} />
          <Rest value={contextCount} />
        </>
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(2)
  })

  it('多层 wrapper 内部存在固定 max 时保守失败', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const Leaf = ({ value }) => <InputNumber value={value} max={20} />
      const Middle = (props) => <Leaf {...props} />
      const Top = (props) => <Middle {...props} />
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <Top value={contextCount} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_WRAPPER_MAX' })])
  })

  it('纯 props 多层透明 wrapper 只删除根调用点的 max', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const Leaf = (props) => <InputNumber {...props} />
      const Middle = (props) => <Leaf {...props} />
      const Top = (props) => <Middle {...props} />
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <Top value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.diagnostics).toEqual([])
    expect(result.candidates).toHaveLength(1)
    expect(result.changed).toBe(1)
    expect(result.content).toContain('<InputNumber {...props} />')
    expect(result.content).toContain('<Top value={contextCount} />')
  })

  it('wrapper 内层 InputNumber 声明 parser 时 fail-closed', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const Leaf = (props) => <InputNumber {...props} parser={(raw) => String(Math.min(Number(raw), 20))} />
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <Leaf value={contextCount} max={20} onChange={setContextCount} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_NUMERIC_BEHAVIOR' })])
    )
  })

  it('wrapper 内层 InputNumber 限幅 onChange 时 fail-closed', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const Leaf = ({ value, onChange }) => (
        <InputNumber value={value} max={20} onChange={(value) => onChange(Math.min(value ?? 0, 20))} />
      )
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <Leaf value={contextCount} onChange={setContextCount} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: expect.stringMatching(/UNRESOLVED_NUMERIC_BEHAVIOR|HIDDEN_CONTEXT_LIMIT|UNRESOLVED_WRAPPER/)
        })
      ])
    )
  })

  it('wrapper 的未知 spread max 不会静默通过', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const Risky = (props) => <InputNumber value={props.value} {...getInputProps(props)} />
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <Risky value={contextCount} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_WRAPPER_MAX' })])
  })

  it('obj.contextCount、元素访问和复合对象都不是可信上下文数值', () => {
    const source = `
      import { InputNumber } from 'antd'
      const direct = settings.contextCount
      const computed = settings['contextCount']
      const options = { contextCount }
      const View = () => <>
        <InputNumber value={direct} max={20} />
        <InputNumber value={computed} max={20} />
        <InputNumber value={options} max={20} />
      </>
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics).toEqual([])
    expect(result.content).toBe(source)
  })

  it('全局调用及被改写的 Number、Math、sanitizer 都作为不透明变换安全失败', () => {
    const source = `
      import { InputNumber as AntInputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'

      const GlobalNumber = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={Number(contextCount)} max={20} />
      }
      const GlobalMath = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={Math.max(contextCount, 1)} max={20} />
      }
      const LocalNumber = ({ settings }) => {
        let Number = globalThis.Number
        Number = coerceTemperature
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={Number(contextCount)} max={20} />
      }
      const LocalMath = ({ settings }) => {
        let Math = globalThis.Math
        Math = customMath
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={Math.max(contextCount, 1)} max={20} />
      }
      const LocalSanitizer = ({ settings }) => {
        const sanitizeContextCount = (value) => value
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <AntInputNumber value={sanitizeContextCount(contextCount)} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics).toHaveLength(5)
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === 'UNRESOLVED_CONTEXT_VALUE')).toBe(true)
    expect(result.content).toBe(source)
  })

  it('识别原生 number 输入并保护原生 range 输入', () => {
    const source = `
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <>
          <input type="number" value={contextCount} max={20} />
          <input type={'range'} value={contextCount} max={20} onChange={setContextCount} />
        </>
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(1)
    expect(result.candidates).toEqual([
      expect.objectContaining({ component: 'input', resolution: 'intrinsic:input[type=number]' })
    ])
    expect(result.ignoredSliders).toEqual([
      expect.objectContaining({ component: 'input', reason: 'intrinsic:input[type=range]', hasMax: true })
    ])
    expect(result.content).toContain(
      "<input type={'range'} value={contextCount} max={20} onChange={setContextCount} />"
    )
  })

  it('Slider 即使 value 经未知调用，只要绑定同一 useState setter 仍会受保护', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const source = `
      import { Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <Slider value={normalizeContextCount(contextCount)} onChange={setContextCount} max={20} />
      }
    `

    const patched = patchContextCountSource(source)

    expect(patched.changed).toBe(0)
    expect(patched.diagnostics).toEqual([])
    expect(patched.ignoredSliders).toEqual([
      expect.objectContaining({ component: 'Slider', hasMax: true, reason: 'import:Slider as Slider' })
    ])
    expect(patched.content).toBe(source)

    const root = createFixture({ 'Settings.tsx': source })
    expect(run({ root, write: true, requireTargets: false, expectedSliders: 1 })).toEqual(
      expect.objectContaining({ candidates: 0, changed: 0, ignoredSliders: 1, diagnostics: [] })
    )
  })

  it('Slider 的后置 spread 可能覆盖 setter 时诊断且不计入保护数量', () => {
    const source = `
      import { Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return (
          <Slider
            onChange={setContextCount}
            {...{ onChange: saveOther }}
            value={normalizeContextCount(contextCount)}
            max={20}
          />
        )
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.ignoredSliders).toEqual([])
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_SLIDER_SETTER' })
    ])
  })

  it('Slider 的 value 与 setter 属于不同 canonical state 时拒绝配对', () => {
    const source = `
      import { Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const Nested = ({ settings }) => {
          const [contextCount, setNestedContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
          return <Slider value={contextCount} onChange={setContextCount} max={20} />
        }
        return <Nested settings={settings} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.ignoredSliders).toEqual([])
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'MISMATCHED_SLIDER_STATE' })])
  })

  it('Slider setter 绑定错误或数量漂移时 expectedSliders 会失败', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const wrongSetter = `
      import { Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <Slider value={normalizeContextCount(contextCount)} onChange={saveContextCount} max={20} />
      }
    `
    const extraSlider = `
      import { Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <>
          <Slider value={firstTransform(contextCount)} onChange={setContextCount} max={20} />
          <Slider value={secondTransform(contextCount)} onChange={setContextCount} max={30} />
        </>
      }
    `
    const wrongSetterRoot = createFixture({ 'Settings.tsx': wrongSetter })
    const extraSliderRoot = createFixture({ 'Settings.tsx': extraSlider })

    expect(() => run({ root: wrongSetterRoot, write: true, requireTargets: false, expectedSliders: 1 })).toThrow(
      'UNRESOLVED_SLIDER_SETTER'
    )
    expect(() => run({ root: extraSliderRoot, write: true, requireTargets: false, expectedSliders: 1 })).toThrow(
      '受保护 Slider 数量异常：期望 1 个，实际 2 个'
    )
  })

  it('只处理 JSX 顶层 max，不误删表达式、注释、字符串或模板中的 max', () => {
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber
          value={contextCount}
          max={40}
          formatter={(max = 20) => max}
          data-audit={() => { max = 30 }}
          aria-label="max=50"
          title={\`max=60 \${contextCount}\`}
          /* max={70} */
        />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(1)
    expect(result.content).not.toContain('max={40}')
    expect(result.content).toContain('formatter={(max = 20) => max}')
    expect(result.content).toContain('data-audit={() => { max = 30 }}')
    expect(result.content).toContain('aria-label="max=50"')
    expect(result.content).toContain('title={`max=60 ${contextCount}`}')
    expect(result.content).toContain('/* max={70} */')
  })

  it('在非 BMP 字符和 CRLF 前后仍保持精确编辑范围', () => {
    const emoji = '😾'.repeat(50)
    const source = `import { InputNumber } from 'antd'\r\nimport { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'\r\nimport { useState } from 'react'\r\nconst View = ({ settings }) => {\r\n  const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)\r\n  return <InputNumber title="${emoji}" value={contextCount}\r\n    max={20}\r\n    data-note="保留" />\r\n}\r\n`

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(1)
    expect(result.content).not.toContain('max={20}')
    expect(result.content).toContain(`title="${emoji}"`)
    expect(result.content).toContain('data-note="保留" />')
    expect(result.content).toContain('\r\n')
  })

  it('无法证明未知包装组件类型时拒绝修改并返回可定位诊断', () => {
    const source = `
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <MysteryField value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'UNRESOLVED_COMPONENT',
        line: 6,
        column: 16,
        message: expect.stringContaining('该组件绑定 contextCount')
      })
    ])
  })

  it('未知组件即使没有可见 max 也不会被静默忽略', () => {
    const source = `
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <MysteryField value={contextCount} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_COMPONENT' })])
  })

  it('spread 属性无法静态证明 max 时返回契约错误', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const source = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber {...inputProps} value={contextCount} max={20} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_NUMERIC_BEHAVIOR' })
    ])

    const root = createFixture({ 'Spread.tsx': source })
    expect(() => run({ root, write: true, requireTargets: true })).toThrow('UNRESOLVED_NUMERIC_BEHAVIOR')
  })

  it('未知组件即使只有 spread 也会因潜在 max 安全失败', () => {
    const source = `
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <MysteryField value={contextCount} {...inputProps} />
      }
    `

    const result = patchContextCountSource(source)

    expect(result.changed).toBe(0)
    expect(result.content).toBe(source)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'UNRESOLVED_COMPONENT' })])
  })

  it('只信任实际解析且无有限上界的 isValidContextCount guard', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const settings = `
      import { InputNumber, Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { isValidContextCount } from '@renderer/utils/contextCount'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const onContextCountChange = (value) => {
          if (isValidContextCount(value)) setContextCount(value)
        }
        return <>
          <InputNumber value={contextCount} onChange={onContextCountChange} />
          <Slider value={contextCount} onChange={setContextCount} />
        </>
      }
    `
    const healthyRoot = createFixture({ 'Settings.tsx': settings, 'utils/contextCount.ts': healthyContextGuard })
    const cappedRoot = createFixture({
      'Settings.tsx': settings,
      'utils/contextCount.ts': `
        export function isValidContextCount(value: unknown): value is number {
          return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 20
        }
      `
    })

    expect(
      run({ root: healthyRoot, write: false, requireTargets: true, expectedTargets: 1, expectedSliders: 1 })
    ).toEqual(expect.objectContaining({ candidates: 1, ignoredSliders: 1, changed: 0 }))
    expect(() =>
      run({ root: cappedRoot, write: false, requireTargets: true, expectedTargets: 1, expectedSliders: 1 })
    ).toThrow('TRUSTED_GUARD_CONTRACT')
  })

  it.each([
    ['否定 guard 直接写入', 'if (!isValidContextCount(value)) setContextCount(value)'],
    ['null 比较直接写入', 'if (value === null) setContextCount(value)'],
    ['正向 guard 后反向写入', 'if (isValidContextCount(value)) return\n    setContextCount(value)'],
    [
      '正向 guard 的 else 分支写入',
      'if (isValidContextCount(value)) {\n      return\n    } else {\n      setContextCount(value)\n    }'
    ],
    ['逻辑短路直接写入', 'isValidContextCount(value) && setContextCount(value)']
  ])('canonical setter 在%s时 fail-closed', (_name, handlerBody) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const settings = `
      import { InputNumber, Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { isValidContextCount } from '@renderer/utils/contextCount'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        const onContextCountChange = (value) => {
          ${handlerBody}
        }
        return <>
          <InputNumber value={contextCount} onChange={onContextCountChange} />
          <Slider value={contextCount} onChange={setContextCount} />
        </>
      }
    `
    const root = createFixture({ 'Settings.tsx': settings, 'utils/contextCount.ts': healthyContextGuard })

    expect(() => run({ root, write: false, requireTargets: true, expectedTargets: 1, expectedSliders: 1 })).toThrow(
      'HIDDEN_CONTEXT_LIMIT'
    )
  })

  it('目标数量相同也必须按两个独立 canonical state 和页面一一配对', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const pairedPage = (name: string) => `
      import { InputNumber, Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const ${name} = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <>
          <InputNumber value={contextCount} onChange={setContextCount} />
          <Slider value={contextCount} onChange={setContextCount} />
        </>
      }
    `
    const duplicatedPage = `
      import { InputNumber, Slider } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const OnlyPage = ({ settings }) => {
        const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <>
          <InputNumber value={contextCount} onChange={setContextCount} />
          <InputNumber value={contextCount} onChange={setContextCount} />
          <Slider value={contextCount} onChange={setContextCount} />
          <Slider value={contextCount} onChange={setContextCount} />
        </>
      }
    `
    const healthyRoot = createFixture({ 'First.tsx': pairedPage('First'), 'Second.tsx': pairedPage('Second') })
    const duplicateRoot = createFixture({ 'Only.tsx': duplicatedPage })
    const transformedSliderRoot = createFixture({
      'Transformed.tsx': `
        import { InputNumber, Slider } from 'antd'
        import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
        import { useState } from 'react'
        const Transformed = ({ settings }) => {
          const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
          return <>
            <InputNumber value={contextCount} onChange={setContextCount} />
            <Slider value={sanitizeContextCount(contextCount)} onChange={setContextCount} />
          </>
        }
      `
    })
    const unrelatedSliderRoot = createFixture({
      'Unrelated.tsx': `
        import { InputNumber, Slider } from 'antd'
        import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
        import { useState } from 'react'
        const Unrelated = ({ settings, temperature }) => {
          const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
          return <>
            <InputNumber value={contextCount} onChange={setContextCount} />
            <Slider value={temperature} onChange={setContextCount} />
          </>
        }
      `
    })
    const missingSliderValueRoot = createFixture({
      'MissingSliderValue.tsx': `
        import { InputNumber, Slider } from 'antd'
        import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
        import { useState } from 'react'
        const MissingSliderValue = ({ settings }) => {
          const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
          return <>
            <InputNumber value={contextCount} onChange={setContextCount} />
            <Slider onChange={setContextCount} />
          </>
        }
      `
    })
    const missingOnChangeRoot = createFixture({
      'Missing.tsx': `
        import { InputNumber, Slider } from 'antd'
        import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
        import { useState } from 'react'
        const Missing = ({ settings }) => {
          const [contextCount, setContextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
          return <>
            <InputNumber value={contextCount} />
            <Slider value={contextCount} onChange={setContextCount} />
          </>
        }
      `
    })

    expect(
      run({ root: healthyRoot, write: false, requireTargets: true, expectedTargets: 2, expectedSliders: 2 })
    ).toEqual(expect.objectContaining({ candidates: 2, ignoredSliders: 2, changed: 0 }))
    expect(
      run({ root: transformedSliderRoot, write: false, requireTargets: true, expectedTargets: 1, expectedSliders: 1 })
    ).toEqual(expect.objectContaining({ candidates: 1, ignoredSliders: 1, changed: 0 }))
    expect(() =>
      run({ root: duplicateRoot, write: false, requireTargets: true, expectedTargets: 2, expectedSliders: 2 })
    ).toThrow('canonical state 配对异常')
    expect(() =>
      run({ root: unrelatedSliderRoot, write: false, requireTargets: true, expectedTargets: 1, expectedSliders: 1 })
    ).toThrow('UNRESOLVED_SLIDER_VALUE')
    expect(() =>
      run({ root: missingSliderValueRoot, write: false, requireTargets: true, expectedTargets: 1, expectedSliders: 1 })
    ).toThrow('UNRESOLVED_SLIDER_VALUE')
    expect(() =>
      run({ root: missingOnChangeRoot, write: false, requireTargets: true, expectedTargets: 1, expectedSliders: 1 })
    ).toThrow('缺少 onChange')
  })

  it('CLI 在目标数量异常时先失败，不留下部分写入', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const original = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber value={contextCount} max={20} />
      }
    `
    const root = createFixture({ 'Settings.tsx': original })

    expect(() => run({ root, write: true, requireTargets: true, expectedTargets: 2 })).toThrow(
      '上下文输入组件数量异常：期望 2 个，实际 1 个'
    )
    expect(fs.readFileSync(path.join(root, 'Settings.tsx'), 'utf8')).toBe(original)
  })

  it('CLI 在语法损坏或未知目标出现时安全失败', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const syntaxRoot = createFixture({ 'Broken.tsx': `const View = () => <InputNumber value={contextCount} max={20}` })
    const unknownRoot = createFixture({
      'Changed.tsx': `
        import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
        import { useState } from 'react'
        const View = ({ settings }) => {
          const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
          return <NewControl value={contextCount} max={20} />
        }
      `
    })

    expect(() => run({ root: syntaxRoot, write: true, requireTargets: true })).toThrow('PARSE_ERROR')
    expect(() => run({ root: unknownRoot, write: true, requireTargets: true })).toThrow('UNRESOLVED_COMPONENT')
  })

  it('多文件写入在中途晋级失败时完整回滚', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const first = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber value={contextCount} max={20} />
      }
    `
    const second = `
      import { InputNumber as EditableNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <EditableNumber value={contextCount} max={30} />
      }
    `
    const root = createFixture({ 'A.tsx': first, 'B.tsx': second })
    let installAttempts = 0

    const renameSync = (oldPath: string, newPath: string): void => {
      if (oldPath.endsWith('.tmp')) {
        installAttempts += 1
        if (installAttempts === 2) throw new Error('injected commit failure')
      }
      fs.renameSync(oldPath, newPath)
    }

    expect(() => run({ root, write: true, requireTargets: true }, { renameSync })).toThrow('已完整回滚')
    expect(fs.readFileSync(path.join(root, 'A.tsx'), 'utf8')).toBe(first)
    expect(fs.readFileSync(path.join(root, 'B.tsx'), 'utf8')).toBe(second)
    expect(fs.readdirSync(root).sort()).toEqual(['A.tsx', 'B.tsx'])
  })

  it('写入成功后备份清理失败时保留新文件和可恢复备份', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const original = `
      import { InputNumber } from 'antd'
      import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
      import { useState } from 'react'
      const View = ({ settings }) => {
        const [contextCount] = useState<number>(settings.contextCount ?? DEFAULT_CONTEXTCOUNT)
        return <InputNumber value={contextCount} max={20} />
      }
    `
    const root = createFixture({ 'Settings.tsx': original })
    const filePath = path.join(root, 'Settings.tsx')
    const unlinkSync = (targetPath: string): void => {
      if (targetPath.endsWith('.bak')) throw new Error('injected backup cleanup failure')
      fs.unlinkSync(targetPath)
    }

    const result = run({ root, write: true, requireTargets: true }, { unlinkSync })

    expect(result).toEqual(expect.objectContaining({ candidates: 1, changed: 1 }))
    expect(fs.readFileSync(filePath, 'utf8')).toContain('<InputNumber value={contextCount} />')
    const backup = fs.readdirSync(root).find((name) => name.endsWith('.bak'))
    expect(backup).toBeDefined()
    expect(fs.readFileSync(path.join(root, backup!), 'utf8')).toBe(original)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('备份清理失败（保留备份供恢复）'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('injected backup cleanup failure'))
  })

  it('EditableNumber 仅校验实际绑定到 InputNumber.value 的镜像，并允许依赖数组包含额外依赖', () => {
    const implementation = `
      import { InputNumber } from 'antd'
      import { useEffect, useState } from 'react'
      const EditableNumber = ({ value, max, onChange }) => {
        const [inputValue, setInputValue] = useState(value)
        const [unrelatedValue, setUnrelatedValue] = useState(value)
        const cappedUnrelatedValue = Math.min(unrelatedValue ?? 0, 20)
        useEffect(() => setInputValue(value), [value, unrelatedValue])
        const handleChange = (newValue) => onChange?.(newValue ?? null)
        return <InputNumber value={inputValue} max={max} onChange={handleChange} />
      }
      export default EditableNumber
    `

    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const root = createEditableNumberFixture(implementation)
    const result = run({ root, write: true, requireTargets: true, expectedTargets: 1, expectedSliders: 0 })

    expect(result).toEqual(expect.objectContaining({ candidates: 1, changed: 1, diagnostics: [] }))
  })

  it.each([
    [
      '条件分支中的同步 effect',
      `
        import { InputNumber } from 'antd'
        import { useEffect, useState } from 'react'
        const EditableNumber = ({ value, max, onChange }) => {
          const [inputValue, setInputValue] = useState(value)
          const enabled = true
          if (enabled) useEffect(() => setInputValue(value), [value])
          const handleChange = (newValue) => onChange?.(newValue ?? null)
          return <InputNumber value={inputValue} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
    ],
    [
      '空依赖同步 effect',
      `
        import { InputNumber } from 'antd'
        import { useEffect, useState } from 'react'
        const EditableNumber = ({ value, max, onChange }) => {
          const [inputValue, setInputValue] = useState(value)
          useEffect(() => setInputValue(value), [])
          const handleChange = (newValue) => onChange?.(newValue ?? null)
          return <InputNumber value={inputValue} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
    ],
    [
      '镜像 setter 别名',
      `
        import { InputNumber } from 'antd'
        import { useEffect, useState } from 'react'
        const EditableNumber = ({ value, max, onChange }) => {
          const [inputValue, setInputValue] = useState(value)
          const alias = setInputValue
          useEffect(() => setInputValue(value), [value])
          alias(value)
          const handleChange = (newValue) => onChange?.(newValue ?? null)
          return <InputNumber value={inputValue} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
    ],
    [
      '镜像 setter 写入常量',
      `
        import { InputNumber } from 'antd'
        import { useEffect, useState } from 'react'
        const EditableNumber = ({ value, max, onChange }) => {
          const [inputValue, setInputValue] = useState(value)
          useEffect(() => setInputValue(value), [value])
          setInputValue(20)
          const handleChange = (newValue) => onChange?.(newValue ?? null)
          return <InputNumber value={inputValue} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
    ],
    [
      'onChange handler 额外原值调用',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, max, onChange }) => {
          const handleChange = (newValue) => {
            onChange?.(newValue ?? null)
            onChange?.(20)
          }
          return <InputNumber value={value} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
    ],
    [
      'effect 额外调用 handler',
      `
        import { InputNumber } from 'antd'
        import { useEffect } from 'react'
        const EditableNumber = ({ value, max, onChange }) => {
          const handleChange = (newValue) => onChange?.(newValue ?? null)
          useEffect(() => handleChange(20), [value])
          return <InputNumber value={value} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
    ]
  ])('EditableNumber %s 时契约必须 fail-closed', (_name, implementation) => {
    expectEditableNumberContractFailure(implementation)
  })

  it.each([
    [
      '重复 value 解构属性',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, value: secondaryValue, max, onChange }) => {
          const handleChange = (newValue) => onChange?.(newValue ?? null)
          return <InputNumber value={value} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
    ],
    [
      '重复 max 解构属性',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, max, max: secondaryMax, onChange }) => {
          const handleChange = (newValue) => onChange?.(newValue ?? null)
          return <InputNumber value={value} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
    ],
    [
      '重复 onChange 解构属性',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, max, onChange, onChange: secondaryOnChange }) => {
          const handleChange = (newValue) => onChange?.(newValue ?? null)
          return <InputNumber value={value} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
    ]
  ])('EditableNumber %s 时拒绝重复组件参数', (_name, implementation) => {
    expectEditableNumberContractFailure(implementation)
  })

  it.each([
    [
      'handler 默认参数',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, max, onChange }) => {
          const handleChange = (newValue = 20) => onChange?.(newValue ?? null)
          return <InputNumber value={value} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
    ],
    [
      'handler rest 参数',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, max, onChange }) => {
          const handleChange = (...newValues) => onChange?.(newValues[0] ?? null)
          return <InputNumber value={value} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
    ],
    [
      'handler 可选参数',
      `
        import { InputNumber } from 'antd'
        const EditableNumber = ({ value, max, onChange }) => {
          const handleChange = (newValue?: number) => onChange?.(newValue ?? null)
          return <InputNumber value={value} max={max} onChange={handleChange} />
        }
        export default EditableNumber
      `
    ]
  ])('EditableNumber %s 时拒绝隐藏输入转换', (_name, implementation) => {
    expectEditableNumberContractFailure(implementation)
  })
})
