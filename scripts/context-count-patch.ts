import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 上游 v1 的上下文设置同时使用 EditableNumber 和 antd InputNumber。
 * 这里只移除带有 contextCount 的输入组件的 max 属性，Slider 等其他控件保持不变。
 */
const INPUT_COMPONENT_SUFFIX = /(?:EditableNumber|InputNumber)$/
const CONTEXT_VALUE = /\bvalue\s*=\s*\{\s*contextCount\s*\}/u
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'coverage'])

export interface ContextCountCandidate {
  component: string
  start: number
  end: number
  hasMax: boolean
}

export interface ContextCountPatchResult {
  content: string
  candidates: ContextCountCandidate[]
  changed: number
}

function isIdentifierStart(char: string | undefined): boolean {
  return !!char && /[A-Za-z_$]/u.test(char)
}

function isIdentifierPart(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$.:-]/u.test(char)
}

function scanQuoted(source: string, start: number, quote: string): number {
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === quote) {
      return index + 1
    }
  }
  return source.length
}

function scanBraces(source: string, start: number): number {
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '"' || char === "'") {
      index = scanQuoted(source, index, char) - 1
      continue
    }
    if (char === '`') {
      index = scanQuoted(source, index, char) - 1
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const lineEnd = source.indexOf('\n', index + 2)
      index = lineEnd === -1 ? source.length : lineEnd - 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2)
      index = commentEnd === -1 ? source.length : commentEnd + 1
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return source.length
}

function maskCommentsAndStrings(source: string): string {
  const chars = [...source]
  let mode: 'code' | 'lineComment' | 'blockComment' | 'single' | 'double' | 'template' = 'code'
  let escaped = false

  const blank = (index: number) => {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
  }

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    const next = chars[index + 1]
    if (mode === 'lineComment') {
      blank(index)
      if (char === '\n' || char === '\r') mode = 'code'
      continue
    }
    if (mode === 'blockComment') {
      blank(index)
      if (char === '*' && next === '/') {
        blank(index + 1)
        index += 1
        mode = 'code'
      }
      continue
    }
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      blank(index)
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (
        (mode === 'single' && char === "'") ||
        (mode === 'double' && char === '"') ||
        (mode === 'template' && char === '`')
      ) {
        mode = 'code'
      }
      continue
    }
    if (char === '/' && next === '/') {
      blank(index)
      blank(index + 1)
      index += 1
      mode = 'lineComment'
    } else if (char === '/' && next === '*') {
      blank(index)
      blank(index + 1)
      index += 1
      mode = 'blockComment'
    } else if (char === "'") {
      blank(index)
      mode = 'single'
    } else if (char === '"') {
      blank(index)
      mode = 'double'
    } else if (char === '`') {
      blank(index)
      mode = 'template'
    }
  }
  return chars.join('')
}

function findTagEnd(source: string, start: number): number {
  let braceDepth = 0
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '"' || char === "'") {
      index = scanQuoted(source, index, char) - 1
      continue
    }
    if (char === '{') {
      braceDepth += 1
      continue
    }
    if (char === '}' && braceDepth > 0) {
      braceDepth -= 1
      continue
    }
    if (char === '>' && braceDepth === 0) return index + 1
  }
  return -1
}

function findOpeningTags(source: string): ContextCountCandidate[] {
  const candidates: ContextCountCandidate[] = []
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '<' || !isIdentifierStart(source[index + 1]) || source[index + 1] === '/') continue

    let nameEnd = index + 1
    while (isIdentifierPart(source[nameEnd])) nameEnd += 1
    const component = source.slice(index + 1, nameEnd)
    if (!INPUT_COMPONENT_SUFFIX.test(component)) {
      index = nameEnd - 1
      continue
    }

    const end = findTagEnd(source, nameEnd)
    if (end === -1) break
    const tag = source.slice(nameEnd, end)
    if (!CONTEXT_VALUE.test(tag)) {
      index = end - 1
      continue
    }
    candidates.push({
      component,
      start: index,
      end,
      hasMax: findMaxAttributeRanges(source.slice(index, end)).length > 0
    })
    index = end - 1
  }
  return candidates
}

function findMaxAttributeRanges(tag: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let index = 1

  // 跳过组件名；后续内容只有顶层 JSX 属性，或必须整体跳过的表达式。
  while (isIdentifierPart(tag[index])) index += 1

  while (index < tag.length) {
    const char = tag[index]
    if (char === '"' || char === "'" || char === '`') {
      index = scanQuoted(tag, index, char)
      continue
    }
    if (char === '/' && tag[index + 1] === '/') {
      const lineEnd = tag.indexOf('\n', index + 2)
      index = lineEnd === -1 ? tag.length : lineEnd
      continue
    }
    if (char === '/' && tag[index + 1] === '*') {
      const commentEnd = tag.indexOf('*/', index + 2)
      index = commentEnd === -1 ? tag.length : commentEnd + 2
      continue
    }
    if (char === '{') {
      index = scanBraces(tag, index)
      continue
    }
    if (char === '>') break
    if (/\s/u.test(char)) {
      index += 1
      continue
    }

    if (tag.startsWith('max', index) && !isIdentifierPart(tag[index - 1]) && !isIdentifierPart(tag[index + 3])) {
      let equalsIndex = index + 3
      while (/\s/u.test(tag[equalsIndex] ?? '')) equalsIndex += 1
      if (tag[equalsIndex] !== '=') {
        index += 3
        continue
      }

      let valueStart = equalsIndex + 1
      while (/\s/u.test(tag[valueStart] ?? '')) valueStart += 1
      let valueEnd = valueStart
      if (tag[valueStart] === '{') {
        valueEnd = scanBraces(tag, valueStart)
      } else if (tag[valueStart] === '"' || tag[valueStart] === "'" || tag[valueStart] === '`') {
        valueEnd = scanQuoted(tag, valueStart, tag[valueStart])
      } else {
        while (valueEnd < tag.length && !/[\s/>]/u.test(tag[valueEnd])) valueEnd += 1
      }

      let rangeStart = index
      while (rangeStart > 0 && /[ \t\r\n]/u.test(tag[rangeStart - 1])) rangeStart -= 1
      ranges.push([rangeStart, Math.max(valueEnd, equalsIndex + 1)])
      index = Math.max(valueEnd, equalsIndex + 1)
      continue
    }

    index += 1
  }
  return ranges
}

export function patchContextCountSource(content: string): ContextCountPatchResult {
  const candidates = findOpeningTags(maskCommentsAndStrings(content))
  const edits: Array<[number, number]> = []

  for (const candidate of candidates) {
    if (!candidate.hasMax) continue
    const tagBodyStart = candidate.start
    const tag = content.slice(tagBodyStart, candidate.end)
    for (const [start, end] of findMaxAttributeRanges(tag)) {
      edits.push([tagBodyStart + start, tagBodyStart + end])
    }
  }

  let patchedContent = content
  for (const [start, end] of edits.sort((left, right) => right[0] - left[0])) {
    patchedContent = patchedContent.slice(0, start) + patchedContent.slice(end)
  }

  return { content: patchedContent, candidates, changed: edits.length }
}

function listSourceFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
        visit(path.join(directory, entry.name))
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
        !/\.(?:test|spec)\.[^.]+$/u.test(entry.name)
      ) {
        files.push(path.join(directory, entry.name))
      }
    }
  }
  visit(root)
  return files
}

interface CliOptions {
  root: string
  write: boolean
  requireTargets: boolean
  expectedTargets?: number
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = { root: process.cwd(), write: false, requireTargets: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--write') options.write = true
    else if (arg === '--require-targets') options.requireTargets = true
    else if (arg === '--expected-targets') {
      const expectedTargets = Number(argv[++index])
      if (!Number.isSafeInteger(expectedTargets) || expectedTargets < 1) {
        throw new Error('--expected-targets 必须是正整数')
      }
      options.expectedTargets = expectedTargets
    } else if (arg === '--root') options.root = path.resolve(argv[++index] ?? '')
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法: tsx scripts/context-count-patch.ts [--root DIR] [--write] [--require-targets] [--expected-targets N]'
      )
      process.exit(0)
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  return options
}

export function run(options: CliOptions): { files: number; candidates: number; changed: number } {
  if (!fs.existsSync(options.root) || !fs.statSync(options.root).isDirectory()) {
    throw new Error(`目录不存在: ${options.root}`)
  }

  let fileCount = 0
  let candidateCount = 0
  let changedCount = 0
  for (const filePath of listSourceFiles(options.root)) {
    const original = fs.readFileSync(filePath, 'utf8')
    const result = patchContextCountSource(original)
    if (result.candidates.length === 0) continue
    fileCount += 1
    candidateCount += result.candidates.length
    changedCount += result.changed
    if (options.write && result.content !== original) fs.writeFileSync(filePath, result.content, 'utf8')
    if (result.changed > 0)
      console.log(`${options.write ? '修补' : '发现'} ${path.relative(options.root, filePath)}: ${result.changed} 处`)
  }

  if (options.requireTargets && candidateCount === 0) throw new Error('未找到上下文输入组件，可能上游已重构')
  if (options.expectedTargets !== undefined && candidateCount !== options.expectedTargets) {
    throw new Error(`上下文输入组件数量异常：期望 ${options.expectedTargets} 个，实际 ${candidateCount} 个`)
  }
  if (!options.write && changedCount > 0) throw new Error(`仍有 ${changedCount} 处上下文输入框存在 max 限制`)
  return { files: fileCount, candidates: candidateCount, changed: changedCount }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = run(parseOptions(process.argv.slice(2)))
    console.log(`上下文输入检查完成：${result.files} 个文件，${result.candidates} 个目标组件`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
