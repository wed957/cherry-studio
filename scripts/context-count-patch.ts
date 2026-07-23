import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as ts from 'typescript'

/**
 * 这是一个有意保持保守的源码补丁器：只删除绑定 `contextCount` 的数字输入组件
 * 的顶层 `max` 属性。所有 JSX 识别都基于 TypeScript AST，避免字符串、注释和
 * UTF-16 偏移影响编辑范围；无法证明组件是数字输入时不会修改源码。
 */

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'coverage'])
const CONTEXT_IDENTIFIER = 'contextCount'
const TRANSPARENT_COMPONENT_HOCS = new Set(['forwardRef', 'memo', 'styled'])
const TRUSTED_REACT_HOC_MODULE = 'react'
const TRUSTED_STYLED_HOC_MODULES = new Set(['styled-components', '@emotion/styled'])
const TRUSTED_EDITABLE_NUMBER_MODULE = '@renderer/components/EditableNumber'
const TRUSTED_EDITABLE_NUMBER_PATH = path.join('components', 'EditableNumber', 'index.tsx')
const TRUSTED_ASSISTANT_HOOK_MODULE = '@renderer/hooks/useAssistant'
const TRUSTED_CONTEXT_GUARD_MODULE = '@renderer/utils/contextCount'
const TRUSTED_CONTEXT_GUARD_PATH = path.join('utils', 'contextCount.ts')
const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
])
const TRUSTED_DEFAULT_COMPONENT_MODULES = new Map<string, ComponentKind>([[TRUSTED_EDITABLE_NUMBER_MODULE, 'numeric']])

type ComponentKind = 'numeric' | 'slider' | 'unknown'
type ContextStateOrigin = 'assistant-parameter' | 'settings-parameter' | 'default-assistant-hook'

interface ComponentResolution {
  kind: ComponentKind
  reason: string
}

export interface ContextCountCandidate {
  component: string
  start: number
  end: number
  hasMax: boolean
  maxCount: number
  line: number
  column: number
  valueExpression: string
  resolution: string
  unresolvedMax: boolean
  hasOnChange: boolean
  stateKey?: string
  stateOrigin?: ContextStateOrigin
}

export interface ContextCountIgnoredSlider {
  component: string
  start: number
  end: number
  line: number
  column: number
  hasMax: boolean
  reason: string
  stateKey?: string
  stateOrigin?: ContextStateOrigin
}

export type ContextCountDiagnosticSeverity = 'error' | 'warning'

export interface ContextCountDiagnostic {
  severity: ContextCountDiagnosticSeverity
  code: string
  message: string
  start?: number
  line?: number
  column?: number
}

export interface ContextCountPatchResult {
  content: string
  candidates: ContextCountCandidate[]
  ignoredSliders: ContextCountIgnoredSlider[]
  diagnostics: ContextCountDiagnostic[]
  changed: number
}

interface SourceParseResult {
  sourceFile: ts.SourceFile
  diagnostics: ContextCountDiagnostic[]
}

interface Edit {
  start: number
  end: number
}

function componentLeaf(name: string): string {
  const pieces = name.split(/[.:]/u)
  return pieces[pieces.length - 1] ?? name
}

function classifyComponentName(name: string): ComponentResolution {
  const leaf = componentLeaf(name)
  const normalized = leaf.replace(/[^A-Za-z0-9]/gu, '').toLowerCase()

  // Slider 名称优先级最高，避免误改 SliderInputNumber 之类的包装组件。
  if (normalized === 'slider') return { kind: 'slider', reason: `name:${name}` }

  if (normalized === 'inputnumber' || normalized === 'editablenumber' || normalized === 'numberinput') {
    return { kind: 'numeric', reason: `name:${name}` }
  }

  return { kind: 'unknown', reason: `name:${name}` }
}

function diagnosticFromTs(sourceFile: ts.SourceFile, diagnostic: ts.Diagnostic): ContextCountDiagnostic {
  const start = diagnostic.start
  const location = start === undefined ? undefined : sourceFile.getLineAndCharacterOfPosition(start)
  return {
    severity: 'error',
    code: 'PARSE_ERROR',
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    ...(start === undefined ? {} : { start, line: (location?.line ?? 0) + 1, column: (location?.character ?? 0) + 1 })
  }
}

function scriptKindForFile(fileName: string): ts.ScriptKind {
  switch (path.extname(fileName).toLowerCase()) {
    case '.js':
      // renderer 中的 JavaScript 文件也可能直接包含 JSX。
      return ts.ScriptKind.JSX
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.ts':
      return ts.ScriptKind.TS
    default:
      return ts.ScriptKind.TSX
  }
}

function parseSource(content: string, fileName: string): SourceParseResult {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKindForFile(fileName))
  const parseDiagnostics =
    (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  return {
    sourceFile,
    diagnostics: parseDiagnostics.map((diagnostic) => diagnosticFromTs(sourceFile, diagnostic))
  }
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    current.kind === ts.SyntaxKind.SatisfiesExpression
  ) {
    current = (
      current as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.NonNullExpression
        | ts.SatisfiesExpression
    ).expression
  }
  return current
}

function collectOpeningElements(root: ts.Node): Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> {
  const openings: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) openings.push(node.openingElement)
    else if (ts.isJsxSelfClosingElement(node)) openings.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return openings
}

type WrapperFunction = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration

function collectReturnedExpressions(wrapper: WrapperFunction): ts.Expression[] {
  if (!wrapper.body) return []
  const returnedExpressions: ts.Expression[] = []
  if (!ts.isBlock(wrapper.body)) returnedExpressions.push(wrapper.body)
  else {
    const collectReturns = (node: ts.Node): void => {
      if (node !== wrapper && isFunctionScope(node)) return
      if (ts.isReturnStatement(node)) {
        if (node.expression) returnedExpressions.push(node.expression)
        return
      }
      ts.forEachChild(node, collectReturns)
    }
    collectReturns(wrapper.body)
  }
  return returnedExpressions
}

function collectReturnedOpeningElements(
  wrapper: WrapperFunction
): Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> {
  const openings: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = []
  const collectOpenings = (node: ts.Node): void => {
    if (node !== wrapper && isFunctionScope(node)) return
    if (ts.isJsxElement(node)) openings.push(node.openingElement)
    else if (ts.isJsxSelfClosingElement(node)) openings.push(node)
    ts.forEachChild(node, collectOpenings)
  }
  for (const expression of collectReturnedExpressions(wrapper)) collectOpenings(expression)
  return openings
}

function jsxNameText(name: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isPropertyAccessExpression(name))
    return `${jsxNameText(name.expression as ts.JsxTagNameExpression)}.${name.name.text}`
  if (ts.isJsxNamespacedName(name)) return `${jsxNameText(name.namespace)}:${name.name.text}`
  return name.getText()
}

function attributeByName(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): ts.JsxAttribute[] {
  return opening.attributes.properties.filter(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === name
  )
}

function attributeExpression(attribute: ts.JsxAttribute | undefined): ts.Expression | undefined {
  if (!attribute?.initializer || !ts.isJsxExpression(attribute.initializer)) return undefined
  return attribute.initializer.expression
}

function attributeStringValue(attribute: ts.JsxAttribute | undefined): string | undefined {
  if (!attribute?.initializer) return undefined
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text
  const expression = attributeExpression(attribute)
  return expression && ts.isStringLiteralLike(expression) ? expression.text : undefined
}

type LexicalScope =
  | ts.SourceFile
  | ts.FunctionLikeDeclaration
  | ts.Block
  | ts.CaseBlock
  | ts.ForStatement
  | ts.ForInStatement
  | ts.ForOfStatement
  | ts.CatchClause

interface LexicalBinding {
  identifier: ts.Identifier
  declaration: ts.Declaration
  scope: LexicalScope
  readonly: boolean
  initializer?: ts.Expression
  propertyName?: string
}

function isFunctionScope(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionLike(node)
}

function containingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isFunctionScope(current)) return current
  }
  return undefined
}

function isLexicalScope(node: ts.Node): node is LexicalScope {
  return (
    ts.isSourceFile(node) ||
    isFunctionScope(node) ||
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node)
  )
}

function nearestScope(node: ts.Node, functionScoped: boolean): LexicalScope {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (functionScoped) {
      if (isFunctionScope(current) || ts.isSourceFile(current)) return current
    } else if (isLexicalScope(current)) return current
  }
  throw new Error('无法确定声明的词法作用域')
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name]
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name)))
}

function bindingElementForIdentifier(identifier: ts.Identifier): ts.BindingElement | undefined {
  let current: ts.Node = identifier
  while (ts.isBindingName(current.parent)) current = current.parent
  return ts.isBindingElement(current.parent) ? current.parent : undefined
}

function bindingPropertyName(identifier: ts.Identifier): string | undefined {
  const element = bindingElementForIdentifier(identifier)
  if (!element) return undefined
  const propertyName = element.propertyName
  if (propertyName && (ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName))) return propertyName.text
  return ts.isObjectBindingPattern(element.parent) ? identifier.text : undefined
}

function createBindingIndex(sourceFile: ts.SourceFile) {
  const byScope = new Map<LexicalScope, Map<string, LexicalBinding[]>>()
  const byIdentifier = new Map<ts.Identifier, LexicalBinding>()

  const add = (binding: LexicalBinding): void => {
    const names = byScope.get(binding.scope) ?? new Map<string, LexicalBinding[]>()
    const entries = names.get(binding.identifier.text) ?? []
    entries.push(binding)
    names.set(binding.identifier.text, entries)
    byScope.set(binding.scope, names)
    byIdentifier.set(binding.identifier, binding)
  }

  const addBindingName = (
    name: ts.BindingName,
    declaration: ts.Declaration,
    scope: LexicalScope,
    readonly: boolean,
    initializer?: ts.Expression
  ): void => {
    for (const identifier of bindingIdentifiers(name)) {
      add({
        identifier,
        declaration,
        scope,
        readonly,
        ...(ts.isIdentifier(name) && identifier === name && initializer ? { initializer } : {}),
        ...(bindingPropertyName(identifier) ? { propertyName: bindingPropertyName(identifier) } : {})
      })
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isCatchClause(node.parent)) {
      addBindingName(node.name, node, node.parent, false, node.initializer)
    } else if (ts.isVariableDeclaration(node)) {
      const declarationList = node.parent
      const isConst =
        ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0
      const isBlockScoped =
        ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0
      addBindingName(node.name, node, nearestScope(node, !isBlockScoped), isConst, node.initializer)
    } else if (ts.isParameter(node)) {
      const scope = node.parent
      if (isFunctionScope(scope)) addBindingName(node.name, node, scope, false, node.initializer)
    } else if (ts.isImportClause(node) && node.name) {
      add({ identifier: node.name, declaration: node, scope: sourceFile, readonly: true })
    } else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node)) {
      add({ identifier: node.name, declaration: node, scope: sourceFile, readonly: true })
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      add({
        identifier: node.name,
        declaration: node,
        scope: nearestScope(node, false),
        readonly: !ts.isFunctionDeclaration(node)
      })
    } else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      add({ identifier: node.name, declaration: node, scope: node as ts.FunctionLikeDeclaration, readonly: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const lookup = (identifier: ts.Identifier): { binding?: LexicalBinding; ambiguous: boolean } => {
    for (let current: ts.Node | undefined = identifier; current; current = current.parent) {
      if (!isLexicalScope(current)) continue
      if (ts.isBlock(current) && ts.isCatchClause(current.parent)) {
        const catchEntries = byScope.get(current.parent)?.get(identifier.text)
        if (catchEntries?.length === 1) return { binding: catchEntries[0], ambiguous: false }
        if (catchEntries && catchEntries.length > 1) return { ambiguous: true }
      }
      const entries = byScope.get(current)?.get(identifier.text)
      if (entries?.length === 1) return { binding: entries[0], ambiguous: false }
      if (entries && entries.length > 1) return { ambiguous: true }
    }
    return { ambiguous: false }
  }

  return {
    resolve: (identifier: ts.Identifier) => lookup(identifier).binding,
    isAmbiguous: (identifier: ts.Identifier) => lookup(identifier).ambiguous,
    bindingOf: (identifier: ts.Identifier) => byIdentifier.get(identifier)
  }
}

type ScalarKind = 'context' | 'scalar' | 'unknown'

interface ContextValueRoots {
  direct: Set<LexicalBinding>
  propsObjects: Set<LexicalBinding>
}

function isTrustedReactCall(
  expression: ts.LeftHandSideExpression,
  expectedName: string,
  bindings: ReturnType<typeof createBindingIndex>
): boolean {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) {
    const binding = bindings.resolve(current)
    return (
      !!binding &&
      ts.isImportSpecifier(binding.declaration) &&
      importedName(binding.declaration) === expectedName &&
      importedModule(binding.declaration) === TRUSTED_REACT_HOC_MODULE
    )
  }
  if (!ts.isPropertyAccessExpression(current) || current.name.text !== expectedName) return false
  let root: ts.Expression = current.expression
  while (ts.isPropertyAccessExpression(root)) root = root.expression
  if (!ts.isIdentifier(root)) return false
  const binding = bindings.resolve(root)
  return (
    !!binding &&
    (ts.isNamespaceImport(binding.declaration) || ts.isImportClause(binding.declaration)) &&
    importedModule(binding.declaration) === TRUSTED_REACT_HOC_MODULE
  )
}

function nodeContains(ancestor: ts.Node, descendant: ts.Node): boolean {
  for (let current: ts.Node | undefined = descendant; current; current = current.parent) {
    if (current === ancestor) return true
  }
  return false
}

function bindingHasWrite(binding: LexicalBinding, bindings: ReturnType<typeof createBindingIndex>): boolean {
  const sourceFile = binding.identifier.getSourceFile()
  let hasWrite = false

  const visit = (node: ts.Node): void => {
    if (hasWrite) return
    if (ts.isIdentifier(node) && node !== binding.identifier && bindings.resolve(node) === binding) {
      for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
        if (
          ts.isBinaryExpression(current) &&
          ASSIGNMENT_OPERATORS.has(current.operatorToken.kind) &&
          nodeContains(current.left, node)
        ) {
          hasWrite = true
          return
        }
        if (
          (ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) &&
          (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken) &&
          nodeContains(current.operand, node)
        ) {
          hasWrite = true
          return
        }
        if ((ts.isForInStatement(current) || ts.isForOfStatement(current)) && nodeContains(current.initializer, node)) {
          hasWrite = true
          return
        }
        if (ts.isDeleteExpression(current) && nodeContains(current.expression, node)) {
          hasWrite = true
          return
        }
        if (isFunctionScope(current) && current !== binding.scope) break
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return hasWrite
}

function bindingEscapesBefore(
  binding: LexicalBinding,
  before: number,
  bindings: ReturnType<typeof createBindingIndex>
): boolean {
  let escaped = false
  const visit = (node: ts.Node): void => {
    if (escaped || node.getStart(binding.identifier.getSourceFile()) >= before) return
    if (ts.isIdentifier(node) && node !== binding.identifier && bindings.resolve(node) === binding) {
      let access: ts.Expression = node
      while (
        (ts.isPropertyAccessExpression(access.parent) || ts.isElementAccessExpression(access.parent)) &&
        access.parent.expression === access
      ) {
        access = access.parent
      }

      if (access === node) {
        escaped = true
        return
      }

      if (ts.isPropertyAccessExpression(access) && access.name.text === 'settings') {
        escaped = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(binding.identifier.getSourceFile())
  return escaped
}

function isTrustedContextStateArgument(
  expression: ts.Expression,
  bindings: ReturnType<typeof createBindingIndex>
): ContextStateOrigin | undefined {
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    expression.kind === ts.SyntaxKind.SatisfiesExpression
  ) {
    return undefined
  }
  const current = unwrapExpression(expression)
  if (!ts.isBinaryExpression(current) || current.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken)
    return undefined

  const configuredValue = current.left
  const properties: string[] = []
  let root: ts.Expression = configuredValue
  while (ts.isPropertyAccessExpression(root)) {
    properties.unshift(root.name.text)
    root = root.expression
  }
  if (!ts.isIdentifier(root) || bindings.isAmbiguous(root)) return undefined

  const rootBinding = bindings.resolve(root)
  if (!rootBinding) return undefined
  const rootElement = bindingElementForIdentifier(rootBinding.identifier)
  const isTrustedParameter =
    ts.isParameter(rootBinding.declaration) &&
    !!rootElement &&
    ts.isObjectBindingPattern(rootElement.parent) &&
    rootElement.parent.parent === rootBinding.declaration &&
    !rootElement.dotDotDotToken &&
    !rootElement.initializer &&
    rootBinding.propertyName === root.text &&
    !bindingHasWrite(rootBinding, bindings) &&
    !bindingEscapesBefore(rootBinding, expression.getStart(), bindings)

  const fromAssistantParameter =
    root.text === 'assistant' &&
    properties.length === 2 &&
    properties[0] === 'settings' &&
    properties[1] === CONTEXT_IDENTIFIER &&
    isTrustedParameter
  const fromSettingsParameter =
    root.text === 'settings' && properties.length === 1 && properties[0] === CONTEXT_IDENTIFIER && isTrustedParameter

  let fromDefaultAssistantHook = false
  if (
    root.text === 'defaultAssistant' &&
    properties.length === 2 &&
    properties[0] === 'settings' &&
    properties[1] === CONTEXT_IDENTIFIER &&
    rootBinding.readonly &&
    ts.isVariableDeclaration(rootBinding.declaration) &&
    !!rootElement &&
    ts.isObjectBindingPattern(rootElement.parent) &&
    rootElement.parent.parent === rootBinding.declaration &&
    !rootElement.dotDotDotToken &&
    !rootElement.initializer &&
    rootBinding.propertyName === 'defaultAssistant' &&
    !bindingHasWrite(rootBinding, bindings) &&
    !bindingEscapesBefore(rootBinding, expression.getStart(), bindings)
  ) {
    const initializer = rootBinding.declaration.initializer
    const hookCall = initializer && unwrapExpression(initializer)
    if (hookCall && ts.isCallExpression(hookCall) && hookCall.arguments.length === 0) {
      const hook = unwrapExpression(hookCall.expression)
      if (ts.isIdentifier(hook) && !bindings.isAmbiguous(hook)) {
        const hookBinding = bindings.resolve(hook)
        fromDefaultAssistantHook =
          !!hookBinding &&
          ts.isImportSpecifier(hookBinding.declaration) &&
          importedName(hookBinding.declaration) === 'useDefaultAssistant' &&
          importedModule(hookBinding.declaration) === TRUSTED_ASSISTANT_HOOK_MODULE
      }
    }
  }
  const origin: ContextStateOrigin | undefined = fromAssistantParameter
    ? 'assistant-parameter'
    : fromSettingsParameter
      ? 'settings-parameter'
      : fromDefaultAssistantHook
        ? 'default-assistant-hook'
        : undefined
  if (!origin) return undefined

  const fallback = current.right
  if (!ts.isIdentifier(fallback) || bindings.isAmbiguous(fallback)) return undefined
  const binding = bindings.resolve(fallback)
  return !!binding &&
    ts.isImportSpecifier(binding.declaration) &&
    importedName(binding.declaration) === 'DEFAULT_CONTEXTCOUNT' &&
    importedModule(binding.declaration) === '@renderer/config/constant'
    ? origin
    : undefined
}

function isCanonicalContextBinding(binding: LexicalBinding, bindings: ReturnType<typeof createBindingIndex>): boolean {
  if (binding.identifier.text !== CONTEXT_IDENTIFIER) return false
  // 包装组件的同名参数是调用方传入的任意值，不能仅凭名字认定为目标上下文。
  if (ts.isParameter(binding.declaration) || ts.isCatchClause(binding.scope) || !binding.readonly) return false
  const element = bindingElementForIdentifier(binding.identifier)
  if (!element || element.initializer || !ts.isArrayBindingPattern(element.parent)) return false
  if (element.parent.elements[0] !== element || !ts.isVariableDeclaration(binding.declaration)) return false
  const initializer = binding.declaration.initializer
  if (!initializer) return false
  const current = unwrapExpression(initializer)
  return (
    ts.isCallExpression(current) &&
    current.typeArguments?.length === 1 &&
    current.typeArguments[0].kind === ts.SyntaxKind.NumberKeyword &&
    current.arguments.length === 1 &&
    isTrustedReactCall(current.expression, 'useState', bindings) &&
    !!isTrustedContextStateArgument(current.arguments[0], bindings)
  )
}

interface CanonicalContextState {
  key: string
  origin: ContextStateOrigin
  valueBinding: LexicalBinding
  setterBinding?: LexicalBinding
}

interface CanonicalContextStates {
  byValue: Map<LexicalBinding, CanonicalContextState>
  bySetter: Map<LexicalBinding, CanonicalContextState>
  all: CanonicalContextState[]
}

function collectCanonicalContextStates(
  sourceFile: ts.SourceFile,
  bindings: ReturnType<typeof createBindingIndex>
): CanonicalContextStates {
  const byValue = new Map<LexicalBinding, CanonicalContextState>()
  const bySetter = new Map<LexicalBinding, CanonicalContextState>()
  const all: CanonicalContextState[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)) {
      const [valueElement, setterElement] = node.name.elements
      if (valueElement && !ts.isOmittedExpression(valueElement)) {
        const valueIdentifier = bindingIdentifiers(valueElement.name)[0]
        const valueBinding = valueIdentifier && bindings.bindingOf(valueIdentifier)
        const initializer = node.initializer && unwrapExpression(node.initializer)
        const origin =
          valueBinding &&
          initializer &&
          ts.isCallExpression(initializer) &&
          initializer.arguments.length === 1 &&
          isCanonicalContextBinding(valueBinding, bindings)
            ? isTrustedContextStateArgument(initializer.arguments[0], bindings)
            : undefined
        if (valueBinding && origin) {
          const setterIdentifier =
            setterElement && !ts.isOmittedExpression(setterElement)
              ? bindingIdentifiers(setterElement.name)[0]
              : undefined
          const setterBinding = setterIdentifier && bindings.bindingOf(setterIdentifier)
          const state: CanonicalContextState = {
            key: `${path.resolve(sourceFile.fileName)}:${node.getStart(sourceFile)}`,
            origin,
            valueBinding,
            ...(setterBinding ? { setterBinding } : {})
          }
          byValue.set(valueBinding, state)
          if (setterBinding) bySetter.set(setterBinding, state)
          all.push(state)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { byValue, bySetter, all }
}

function createContextValueResolver(
  bindings: ReturnType<typeof createBindingIndex>,
  canonicalStates: CanonicalContextStates
) {
  const resolve = (
    expression: ts.Expression,
    roots: ContextValueRoots = { direct: new Set(), propsObjects: new Set() },
    resolving = new Set<LexicalBinding>()
  ): ScalarKind => {
    const current = unwrapExpression(expression)
    if (ts.isIdentifier(current)) {
      if (bindings.isAmbiguous(current)) return 'unknown'
      const binding = bindings.resolve(current)
      if (binding && roots.direct.has(binding)) return 'context'
      if (current.text === CONTEXT_IDENTIFIER && binding && canonicalStates.byValue.has(binding)) {
        return 'context'
      }
      if (!binding || !binding.readonly || !binding.initializer || resolving.has(binding)) return 'unknown'
      resolving.add(binding)
      const result = resolve(binding.initializer, roots, resolving)
      resolving.delete(binding)
      return result
    }
    if (ts.isPropertyAccessExpression(current)) {
      if (current.name.text === 'value' && ts.isIdentifier(current.expression)) {
        const binding = bindings.resolve(current.expression)
        if (binding && roots.propsObjects.has(binding)) return 'context'
      }
      return 'unknown'
    }
    if (ts.isElementAccessExpression(current)) {
      const argument = current.argumentExpression
      if (!argument || !ts.isStringLiteralLike(argument)) return 'unknown'
      if (argument.text === 'value' && ts.isIdentifier(current.expression)) {
        const binding = bindings.resolve(current.expression)
        if (binding && roots.propsObjects.has(binding)) return 'context'
      }
      return 'unknown'
    }
    if (
      ts.isNumericLiteral(current) ||
      ts.isStringLiteralLike(current) ||
      current.kind === ts.SyntaxKind.TrueKeyword ||
      current.kind === ts.SyntaxKind.FalseKeyword ||
      current.kind === ts.SyntaxKind.NullKeyword
    ) {
      return 'scalar'
    }
    if (ts.isPrefixUnaryExpression(current)) {
      return resolve(current.operand, roots, resolving) === 'scalar' ? 'scalar' : 'unknown'
    }
    if (ts.isCallExpression(current)) {
      return 'unknown'
    }
    if (ts.isConditionalExpression(current)) {
      const branches = [resolve(current.whenTrue, roots, resolving), resolve(current.whenFalse, roots, resolving)]
      if (branches.some((kind) => kind === 'unknown')) return 'unknown'
      return branches.some((kind) => kind === 'context') ? 'unknown' : 'scalar'
    }
    if (ts.isBinaryExpression(current)) {
      const supportedOperators = new Set([
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
        ts.SyntaxKind.QuestionQuestionToken
      ])
      if (!supportedOperators.has(current.operatorToken.kind)) return 'unknown'
      const operands = [resolve(current.left, roots, resolving), resolve(current.right, roots, resolving)]
      if (operands.some((kind) => kind === 'unknown')) return 'unknown'
      return operands.some((kind) => kind === 'context') ? 'unknown' : 'scalar'
    }
    return 'unknown'
  }

  const mayContainContext = (
    expression: ts.Expression,
    roots: ContextValueRoots = { direct: new Set(), propsObjects: new Set() },
    seen = new Set<LexicalBinding>()
  ): boolean => {
    const current = unwrapExpression(expression)
    if (resolve(current, roots) === 'context') return true
    if (ts.isIdentifier(current)) {
      const binding = bindings.resolve(current)
      if (!binding || !binding.initializer || seen.has(binding)) return false
      seen.add(binding)
      const result = mayContainContext(binding.initializer, roots, seen)
      seen.delete(binding)
      return result
    }

    let found = false
    const visit = (node: ts.Node): void => {
      if (found) return
      if (ts.isExpression(node) && node !== current && resolve(node, roots) === 'context') {
        found = true
        return
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(current, visit)
    return found
  }

  const contextStates = (expression: ts.Expression, seen = new Set<LexicalBinding>()): Set<CanonicalContextState> => {
    const current = unwrapExpression(expression)
    if (ts.isIdentifier(current)) {
      if (bindings.isAmbiguous(current)) return new Set()
      const binding = bindings.resolve(current)
      const canonical = binding && canonicalStates.byValue.get(binding)
      if (canonical) return new Set([canonical])
      if (!binding || !binding.readonly || !binding.initializer || seen.has(binding)) return new Set()
      seen.add(binding)
      const states = contextStates(binding.initializer, seen)
      seen.delete(binding)
      return states
    }

    const states = new Set<CanonicalContextState>()
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        for (const state of contextStates(node, seen)) states.add(state)
        return
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(current, visit)
    return states
  }

  return {
    resolve,
    isContextScalar: (expression: ts.Expression, roots?: ContextValueRoots) => resolve(expression, roots) === 'context',
    mayContainContext,
    contextStates
  }
}

function importedName(importSpecifier: ts.ImportSpecifier): string {
  return importSpecifier.propertyName?.text ?? importSpecifier.name.text
}

function containingImportDeclaration(node: ts.Node): ts.ImportDeclaration | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isImportDeclaration(current)) return current
    if (ts.isSourceFile(current)) return undefined
  }
  return undefined
}

function importedModule(node: ts.Node): string | undefined {
  const declaration = containingImportDeclaration(node)
  return declaration && ts.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : undefined
}

function collectImports(
  sourceFile: ts.SourceFile,
  trustedDefaultModules: ReadonlySet<string>
): {
  direct: Map<string, ComponentResolution>
} {
  const direct = new Map<string, ComponentResolution>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    const clause = statement.importClause
    const moduleSpecifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ''
    if (clause.name) {
      const trustedKind = trustedDefaultModules.has(moduleSpecifier)
        ? TRUSTED_DEFAULT_COMPONENT_MODULES.get(moduleSpecifier)
        : undefined
      if (trustedKind) {
        direct.set(clause.name.text, {
          kind: trustedKind,
          reason: `import-default:${moduleSpecifier} as ${clause.name.text}`
        })
      }
    }
    if (!clause.namedBindings) continue
    if (ts.isNamespaceImport(clause.namedBindings)) continue
    for (const element of clause.namedBindings.elements) {
      const imported = importedName(element)
      const resolution = classifyComponentName(imported)
      if (moduleSpecifier === 'antd' && resolution.kind !== 'unknown')
        direct.set(element.name.text, { ...resolution, reason: `import:${imported} as ${element.name.text}` })
    }
  }
  return { direct }
}

function combineResolutions(resolutions: ComponentResolution[], fallback: string): ComponentResolution {
  if (resolutions.length === 0) return { kind: 'unknown', reason: fallback }
  const unresolved = resolutions.filter((resolution) => resolution.kind === 'unknown')
  if (unresolved.length > 0) {
    return {
      kind: 'unknown',
      reason: `${fallback}:unknown:${unresolved.map((resolution) => resolution.reason).join('|')}`
    }
  }
  const kinds = new Set(resolutions.map((resolution) => resolution.kind))
  if (kinds.size !== 1) return { kind: 'unknown', reason: `${fallback}:ambiguous` }
  return {
    kind: resolutions[0].kind,
    reason: `${fallback}:${resolutions.map((resolution) => resolution.reason).join('|')}`
  }
}

function createComponentResolver(
  sourceFile: ts.SourceFile,
  bindings: ReturnType<typeof createBindingIndex>,
  trustedDefaultModules: ReadonlySet<string> = new Set()
) {
  const imports = collectImports(sourceFile, trustedDefaultModules)
  const resolving = new Set<string>()

  const transparentHocName = (expression: ts.LeftHandSideExpression): string | undefined => {
    const current = unwrapExpression(expression)
    if (ts.isIdentifier(current)) {
      const binding = bindings.resolve(current)
      if (!binding) return undefined
      const moduleSpecifier = importedModule(binding.declaration)
      if (ts.isImportSpecifier(binding.declaration)) {
        const imported = importedName(binding.declaration)
        if (moduleSpecifier === TRUSTED_REACT_HOC_MODULE && (imported === 'memo' || imported === 'forwardRef')) {
          return imported
        }
        if (imported === 'styled' && moduleSpecifier && TRUSTED_STYLED_HOC_MODULES.has(moduleSpecifier)) {
          return imported
        }
      }
      if (
        ts.isImportClause(binding.declaration) &&
        moduleSpecifier &&
        TRUSTED_STYLED_HOC_MODULES.has(moduleSpecifier)
      ) {
        return 'styled'
      }
      return undefined
    }

    if (ts.isPropertyAccessExpression(current)) {
      let root: ts.Expression = current.expression
      while (ts.isPropertyAccessExpression(root)) root = root.expression
      if (!ts.isIdentifier(root)) return undefined
      const binding = bindings.resolve(root)
      if (
        !binding ||
        (!ts.isNamespaceImport(binding.declaration) && !ts.isImportClause(binding.declaration)) ||
        importedModule(binding.declaration) !== TRUSTED_REACT_HOC_MODULE
      ) {
        return undefined
      }
      const name = current.name.text
      return name === 'memo' || name === 'forwardRef' ? name : undefined
    }

    return undefined
  }

  const resolvePropertyAccess = (property: ts.PropertyAccessExpression): ComponentResolution => {
    let root: ts.Expression = property.expression
    while (ts.isPropertyAccessExpression(root)) root = root.expression
    const name = property.getText(sourceFile)
    if (!ts.isIdentifier(root)) return { kind: 'unknown', reason: `property:${name}` }

    const binding = bindings.resolve(root)
    if (!binding || bindings.isAmbiguous(root)) return { kind: 'unknown', reason: `unresolved-property:${name}` }
    if (!ts.isNamespaceImport(binding.declaration) || importedModule(binding.declaration) !== 'antd') {
      return {
        kind: 'unknown',
        reason: `property-binding:${name}:${ts.SyntaxKind[binding.declaration.kind] ?? binding.declaration.kind}`
      }
    }

    const resolution = classifyComponentName(property.name.text)
    return resolution.kind === 'unknown'
      ? { kind: 'unknown', reason: `namespace:${name}` }
      : { ...resolution, reason: `namespace:${name}` }
  }

  const resolveIdentifier = (identifier: ts.Identifier): ComponentResolution => {
    const name = identifier.text
    if (bindings.isAmbiguous(identifier)) return { kind: 'unknown', reason: `ambiguous-binding:${name}` }
    const binding = bindings.resolve(identifier)
    if (binding) {
      const declaration = binding.declaration
      if (ts.isImportSpecifier(declaration)) {
        const imported = importedName(declaration)
        const resolution = classifyComponentName(imported)
        return importedModule(declaration) !== 'antd' || resolution.kind === 'unknown'
          ? { kind: 'unknown', reason: `import:${imported} as ${name}` }
          : { ...resolution, reason: `import:${imported} as ${name}` }
      }
      if (ts.isImportClause(declaration))
        return imports.direct.get(name) ?? { kind: 'unknown', reason: `import:${name}` }
      if (ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) {
        if (!binding.readonly) return { kind: 'unknown', reason: `mutable-binding:${name}` }
        const key = `${name}:${declaration.pos}`
        if (resolving.has(key)) return { kind: 'unknown', reason: `cycle:${name}` }
        resolving.add(key)
        const resolution = resolveDefinition(declaration)
        resolving.delete(key)
        return { ...resolution, reason: `wrapper:${name}:${resolution.reason}` }
      }
      return { kind: 'unknown', reason: `binding:${ts.SyntaxKind[declaration.kind] ?? declaration.kind}` }
    }

    return { kind: 'unknown', reason: `unresolved:${name}` }
  }

  const resolveTag = (tag: ts.JsxTagNameExpression): ComponentResolution => {
    if (ts.isIdentifier(tag)) return resolveIdentifier(tag)
    if (ts.isPropertyAccessExpression(tag)) return resolvePropertyAccess(tag)
    return { kind: 'unknown', reason: `tag:${jsxNameText(tag)}` }
  }

  const resolveExpression = (expression: ts.Expression): ComponentResolution => {
    const current = unwrapExpression(expression)
    if (ts.isIdentifier(current)) return resolveIdentifier(current)
    if (ts.isPropertyAccessExpression(current)) return resolvePropertyAccess(current)
    if (ts.isJsxSelfClosingElement(current)) return resolveTag(current.tagName)
    if (ts.isJsxElement(current)) return resolveTag(current.openingElement.tagName)
    if (ts.isJsxFragment(current)) {
      const children = current.children.flatMap((child): ComponentResolution[] => {
        if (ts.isJsxText(child)) {
          return child.text.trim() === '' ? [] : [{ kind: 'unknown', reason: 'fragment:text' }]
        }
        if (ts.isJsxExpression(child)) {
          return child.expression
            ? [resolveExpression(child.expression)]
            : child.dotDotDotToken
              ? [{ kind: 'unknown', reason: 'fragment:spread' }]
              : []
        }
        return [resolveExpression(child)]
      })
      return combineResolutions(children, 'fragment-wrapper')
    }
    if (ts.isTaggedTemplateExpression(current)) return resolveExpression(current.tag)
    if (ts.isCallExpression(current)) {
      const hocName = transparentHocName(current.expression)
      if (!hocName || !TRANSPARENT_COMPONENT_HOCS.has(hocName)) {
        return { kind: 'unknown', reason: `untrusted-call:${current.expression.getText(sourceFile)}` }
      }
      const resolutions = current.arguments.map((argument) =>
        ts.isSpreadElement(argument)
          ? ({ kind: 'unknown', reason: 'spread-hoc-argument' } satisfies ComponentResolution)
          : resolveExpression(argument)
      )
      return combineResolutions(resolutions, `hoc:${hocName}`)
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return combineResolutions(collectReturnedExpressions(current).map(resolveExpression), 'function-wrapper')
    }
    if (ts.isConditionalExpression(current)) {
      return combineResolutions(
        [resolveExpression(current.whenTrue), resolveExpression(current.whenFalse)],
        'conditional-wrapper'
      )
    }
    if (ts.isBinaryExpression(current)) {
      return combineResolutions([resolveExpression(current.left), resolveExpression(current.right)], 'binary-wrapper')
    }
    if (ts.isArrayLiteralExpression(current)) {
      return combineResolutions(
        current.elements.map((element) =>
          ts.isExpression(element) ? resolveExpression(element) : { kind: 'unknown', reason: 'non-expression' }
        ),
        'array-wrapper'
      )
    }
    return { kind: 'unknown', reason: `expression:${ts.SyntaxKind[current.kind] ?? current.kind}` }
  }

  function resolveDefinition(node: ts.VariableDeclaration | ts.FunctionDeclaration): ComponentResolution {
    if (ts.isVariableDeclaration(node) && node.initializer) return resolveExpression(node.initializer)
    if (ts.isFunctionDeclaration(node) && node.body) {
      return combineResolutions(
        collectReturnedExpressions(node).map(resolveExpression),
        `function:${node.name?.text ?? 'anonymous'}`
      )
    }
    return { kind: 'unknown', reason: 'empty-definition' }
  }

  const wrapperFunctionsForExpression = (expression: ts.Expression, seen: Set<LexicalBinding>): WrapperFunction[] => {
    const current = unwrapExpression(expression)
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return [current]
    if (ts.isIdentifier(current)) return wrapperFunctionsForIdentifier(current, seen)
    if (ts.isTaggedTemplateExpression(current)) return wrapperFunctionsForExpression(current.tag, seen)
    if (ts.isCallExpression(current)) {
      const hocName = transparentHocName(current.expression)
      if (!hocName || !TRANSPARENT_COMPONENT_HOCS.has(hocName)) return []
      return current.arguments.flatMap((argument) =>
        ts.isSpreadElement(argument) ? [] : wrapperFunctionsForExpression(argument, seen)
      )
    }
    if (ts.isConditionalExpression(current)) {
      return [
        ...wrapperFunctionsForExpression(current.whenTrue, seen),
        ...wrapperFunctionsForExpression(current.whenFalse, seen)
      ]
    }
    if (ts.isBinaryExpression(current)) {
      return [
        ...wrapperFunctionsForExpression(current.left, seen),
        ...wrapperFunctionsForExpression(current.right, seen)
      ]
    }
    if (ts.isArrayLiteralExpression(current)) {
      return current.elements.flatMap((element) =>
        ts.isExpression(element) ? wrapperFunctionsForExpression(element, seen) : []
      )
    }
    return []
  }

  function wrapperFunctionsForIdentifier(
    identifier: ts.Identifier,
    seen = new Set<LexicalBinding>()
  ): WrapperFunction[] {
    const binding = bindings.resolve(identifier)
    if (!binding || !binding.readonly || seen.has(binding)) return []
    const declaration = binding.declaration
    if (ts.isFunctionDeclaration(declaration)) return [declaration]
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return []

    const wrappers = wrapperFunctionsForExpression(declaration.initializer, new Set(seen).add(binding))
    return wrappers.filter((wrapper, index) => wrappers.indexOf(wrapper) === index)
  }

  const wrapperFunctions = (tag: ts.JsxTagNameExpression): WrapperFunction[] =>
    ts.isIdentifier(tag) ? wrapperFunctionsForIdentifier(tag) : []

  const wrapperMayContainMax = (tag: ts.JsxTagNameExpression, seen = new Set<WrapperFunction>()): boolean =>
    wrapperFunctions(tag).some((wrapper) => {
      if (seen.has(wrapper)) return true
      const nextSeen = new Set(seen).add(wrapper)
      return collectReturnedOpeningElements(wrapper).some((opening) => {
        if (
          attributeByName(opening, 'max').length > 0 ||
          opening.attributes.properties.some((property) => ts.isJsxSpreadAttribute(property))
        ) {
          return true
        }
        return wrapperMayContainMax(opening.tagName, nextSeen)
      })
    })

  return { resolveTag, wrapperFunctions, wrapperMayContainMax }
}

function removalRange(source: string, attribute: ts.JsxAttribute): Edit {
  const attributeStart = attribute.getStart()
  const attributeEnd = attribute.end
  const lineStartIndex =
    Math.max(source.lastIndexOf('\n', attributeStart - 1), source.lastIndexOf('\r', attributeStart - 1)) + 1
  const lineEndIndexRaw = source.indexOf('\n', attributeEnd)
  const lineEndIndex = lineEndIndexRaw === -1 ? source.length : lineEndIndexRaw
  const before = source.slice(lineStartIndex, attributeStart)
  const after = source.slice(attributeEnd, lineEndIndex).replace(/\r$/u, '')

  // 独占一行的属性连同行尾一起删除，防止上一行的行注释吞掉 JSX 结束符。
  if (/^[ \t]*$/u.test(before) && /^[ \t]*$/u.test(after)) {
    let end = lineEndIndex
    if (source[end] === '\r' && source[end + 1] === '\n') end += 2
    else if (source[end] === '\n' || source[end] === '\r') end += 1
    return { start: lineStartIndex, end }
  }

  // 行内属性只删除 `max` 前的水平空白，不跨越换行，保留注释与其他格式。
  let start = attributeStart
  while (start > lineStartIndex && /[ \t]/u.test(source[start - 1] ?? '')) start -= 1
  return { start, end: attributeEnd }
}

function formatDiagnostic(diagnostic: ContextCountDiagnostic): string {
  const location = diagnostic.line === undefined ? '' : `:${diagnostic.line}:${diagnostic.column ?? 1}`
  return `${diagnostic.code}${location}: ${diagnostic.message}`
}

type PropValueKind = ScalarKind | 'absent'

interface WrapperContext {
  roots: ContextValueRoots
  trustedProps: Set<LexicalBinding>
  incomingValue: PropValueKind
  incomingStates: Set<CanonicalContextState>
  incomingMaxUnknown: boolean
  unsafeReason?: string
}

interface SpreadState {
  value: PropValueKind
  contextStates: Set<CanonicalContextState>
  maxUnknown: boolean
}

interface OpeningState extends SpreadState {
  maxAttributes: ts.JsxAttribute[]
  contextValueUncertain: boolean
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

function createWrapperContext(
  wrapper: WrapperFunction,
  incomingValue: PropValueKind,
  incomingStates: Set<CanonicalContextState>,
  incomingMaxUnknown: boolean,
  bindings: ReturnType<typeof createBindingIndex>
): WrapperContext {
  const roots: ContextValueRoots = { direct: new Set(), propsObjects: new Set() }
  const trustedProps = new Set<LexicalBinding>()
  const parameter = wrapper.parameters[0]
  if (!parameter) return { roots, trustedProps, incomingValue, incomingStates, incomingMaxUnknown }

  let unsafeReason: string | undefined

  if (ts.isIdentifier(parameter.name)) {
    const binding = bindings.bindingOf(parameter.name)
    if (binding) {
      roots.propsObjects.add(binding)
      trustedProps.add(binding)
    }
  } else if (ts.isObjectBindingPattern(parameter.name)) {
    const excludedProperties = new Set(
      parameter.name.elements
        .filter((element) => !element.dotDotDotToken)
        .map((element) => bindingPropertyName(bindingIdentifiers(element.name)[0]))
        .filter((name): name is string => !!name)
    )
    for (const element of parameter.name.elements) {
      const identifiers = bindingIdentifiers(element.name)
      const propertyName = element.dotDotDotToken ? undefined : bindingPropertyName(identifiers[0])
      for (const identifier of identifiers) {
        const binding = bindings.bindingOf(identifier)
        if (!binding) continue
        if (element.dotDotDotToken) {
          if (excludedProperties.has('value') || excludedProperties.has('max')) {
            unsafeReason = 'rest 参数已排除 value 或 max，不能视为完整透明 props'
          } else trustedProps.add(binding)
        } else if (propertyName === 'value') roots.direct.add(binding)
      }
    }
  }

  const parameterBindings = bindingIdentifiers(parameter.name)
    .map((identifier) => bindings.bindingOf(identifier))
    .filter((binding): binding is LexicalBinding => !!binding)
  const bindingRoles = new Map<LexicalBinding, string>()
  for (const binding of parameterBindings) bindingRoles.set(binding, binding.propertyName ?? 'props')

  const allowedReference = (identifier: ts.Identifier, role: string): boolean => {
    const parent = identifier.parent
    if (
      parent === parameter.name ||
      ts.isBindingElement(parent) ||
      ts.isObjectBindingPattern(parent) ||
      ts.isArrayBindingPattern(parent)
    )
      return true
    if (ts.isJsxAttribute(parent) && parent.name === identifier) return true
    if (ts.isJsxSpreadAttribute(parent) && parent.expression === identifier && role === 'props') return true
    if (ts.isPropertyAccessExpression(parent) && parent.expression === identifier && role === 'props') {
      const propertyRole = parent.name.text
      const jsxExpression = parent.parent
      const attribute = ts.isJsxExpression(jsxExpression) ? jsxExpression.parent : undefined
      return (
        (propertyRole === 'value' || propertyRole === 'max') &&
        !!attribute &&
        ts.isJsxAttribute(attribute) &&
        ts.isIdentifier(attribute.name) &&
        attribute.name.text === propertyRole
      )
    }
    const jsxExpression = parent
    const attribute = ts.isJsxExpression(jsxExpression) ? jsxExpression.parent : undefined
    return (
      (role === 'value' || role === 'max') &&
      !!attribute &&
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === role
    )
  }

  const inspectReferences = (node: ts.Node): void => {
    if (unsafeReason) return
    if (ts.isIdentifier(node)) {
      const binding = bindings.resolve(node)
      const role = binding && bindingRoles.get(binding)
      if (role && node !== binding.identifier && !allowedReference(node, role)) {
        unsafeReason = `包装参数 ${node.text} 除 JSX ${role} 转发外还有其他用途`
        return
      }
    }
    ts.forEachChild(node, inspectReferences)
  }
  if (wrapper.body) inspectReferences(wrapper.body)

  return {
    roots,
    trustedProps,
    incomingValue,
    incomingStates,
    incomingMaxUnknown,
    ...(unsafeReason ? { unsafeReason } : {})
  }
}

function isTrustedPropsExpression(
  expression: ts.Expression,
  context: WrapperContext,
  bindings: ReturnType<typeof createBindingIndex>,
  seen = new Set<LexicalBinding>()
): boolean {
  const current = unwrapExpression(expression)
  if (!ts.isIdentifier(current)) return false
  const binding = bindings.resolve(current)
  if (!binding) return false
  if (context.trustedProps.has(binding)) return true
  if (!binding.readonly || !binding.initializer || seen.has(binding)) return false
  seen.add(binding)
  const trusted = isTrustedPropsExpression(binding.initializer, context, bindings, seen)
  seen.delete(binding)
  return trusted
}

function spreadState(
  expression: ts.Expression,
  context: WrapperContext | undefined,
  bindings: ReturnType<typeof createBindingIndex>,
  values: ReturnType<typeof createContextValueResolver>
): SpreadState {
  if (context && isTrustedPropsExpression(expression, context, bindings)) {
    return {
      value: context.incomingValue,
      contextStates: new Set(context.incomingStates),
      maxUnknown: context.incomingMaxUnknown
    }
  }

  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) {
    return { value: 'unknown', contextStates: values.contextStates(current), maxUnknown: true }
  }

  if (!ts.isObjectLiteralExpression(current)) {
    return { value: 'unknown', contextStates: values.contextStates(current), maxUnknown: true }
  }

  let value: PropValueKind = 'absent'
  let contextStates = new Set<CanonicalContextState>()
  let maxUnknown = false
  for (const property of current.properties) {
    if (ts.isSpreadAssignment(property)) {
      const nested = spreadState(property.expression, context, bindings, values)
      if (nested.value !== 'absent') {
        value = nested.value
        contextStates = nested.contextStates
      }
      maxUnknown ||= nested.maxUnknown
      continue
    }
    if (ts.isPropertyAssignment(property)) {
      const name = propertyNameText(property.name)
      if (name === 'value') {
        value = values.resolve(property.initializer, context?.roots)
        contextStates = values.contextStates(property.initializer)
      } else if (name === 'max' || name === undefined) maxUnknown = true
      continue
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === 'value') {
        value = values.resolve(property.name, context?.roots)
        contextStates = values.contextStates(property.name)
      } else if (property.name.text === 'max') maxUnknown = true
      continue
    }
    const name = propertyNameText(property.name)
    if (name === 'max' || name === undefined) maxUnknown = true
    if (name === 'value') {
      value = 'unknown'
      contextStates = new Set()
    }
  }
  return { value, contextStates, maxUnknown }
}

function openingState(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  context: WrapperContext | undefined,
  bindings: ReturnType<typeof createBindingIndex>,
  values: ReturnType<typeof createContextValueResolver>
): OpeningState {
  let value: PropValueKind = 'absent'
  let contextStates = new Set<CanonicalContextState>()
  let maxUnknown = false
  let contextValueUncertain = false
  const maxAttributes: ts.JsxAttribute[] = []

  for (const property of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(property)) {
      const spread = spreadState(property.expression, context, bindings, values)
      if (
        spread.value === 'unknown' &&
        (value === 'context' || values.mayContainContext(property.expression, context?.roots))
      ) {
        contextValueUncertain = true
      } else if (spread.value !== 'absent') {
        value = spread.value
        contextStates = spread.contextStates
        contextValueUncertain = false
      }
      maxUnknown ||= spread.maxUnknown
      continue
    }
    if (!ts.isIdentifier(property.name)) continue
    if (property.name.text === 'max') {
      maxAttributes.push(property)
      continue
    }
    if (property.name.text !== 'value') continue
    if (!property.initializer) {
      value = 'scalar'
      contextStates = new Set()
    } else if (ts.isStringLiteral(property.initializer)) {
      value = 'scalar'
      contextStates = new Set()
    } else if (ts.isJsxExpression(property.initializer) && property.initializer.expression) {
      value = values.resolve(property.initializer.expression, context?.roots)
      contextStates = values.contextStates(property.initializer.expression)
      if (value === 'context' && contextStates.size === 0 && context) {
        contextStates = new Set(context.incomingStates)
      }
    } else value = 'unknown'
    contextValueUncertain = false
  }

  return { value, contextStates, maxUnknown, maxAttributes, contextValueUncertain }
}

function diagnosticAtOpening(
  sourceFile: ts.SourceFile,
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  code: string,
  message: string
): ContextCountDiagnostic {
  const start = opening.getStart(sourceFile)
  const location = sourceFile.getLineAndCharacterOfPosition(start)
  return {
    severity: 'error',
    code,
    message,
    start,
    line: location.line + 1,
    column: location.character + 1
  }
}

function diagnosticAtNode(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  code: string,
  message: string
): ContextCountDiagnostic {
  const start = node.getStart(sourceFile)
  const location = sourceFile.getLineAndCharacterOfPosition(start)
  return {
    severity: 'error',
    code,
    message,
    start,
    line: location.line + 1,
    column: location.character + 1
  }
}

function localFunctionForExpression(
  expression: ts.Expression,
  bindings: ReturnType<typeof createBindingIndex>
): WrapperFunction | undefined {
  const current = unwrapExpression(expression)
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return current
  if (!ts.isIdentifier(current) || bindings.isAmbiguous(current)) return undefined
  const binding = bindings.resolve(current)
  if (!binding || bindingHasWrite(binding, bindings)) return undefined
  if (ts.isFunctionDeclaration(binding.declaration)) return binding.declaration
  if (!ts.isVariableDeclaration(binding.declaration) || !binding.declaration.initializer) return undefined
  const initializer = unwrapExpression(binding.declaration.initializer)
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) ? initializer : undefined
}

function nodeReferencesAnyBinding(
  node: ts.Node,
  targets: ReadonlySet<LexicalBinding>,
  bindings: ReturnType<typeof createBindingIndex>
): boolean {
  let found = false
  const visit = (current: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(current)) {
      const binding = bindings.resolve(current)
      if (binding && targets.has(binding)) {
        found = true
        return
      }
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

function expressionCalleeName(expression: ts.LeftHandSideExpression): string {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return current.text
  if (ts.isPropertyAccessExpression(current)) return `${expressionCalleeName(current.expression)}.${current.name.text}`
  return current.getText()
}

function containsHiddenUpperBound(
  root: ts.Node,
  tainted: ReadonlySet<LexicalBinding>,
  bindings: ReturnType<typeof createBindingIndex>
): ts.Node | undefined {
  let suspicious: ts.Node | undefined
  const arithmeticOperators = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.PlusToken,
    ts.SyntaxKind.MinusToken,
    ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.AsteriskAsteriskToken,
    ts.SyntaxKind.SlashToken,
    ts.SyntaxKind.PercentToken,
    ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.GreaterThanEqualsToken
  ])
  const visit = (node: ts.Node): void => {
    if (suspicious) return
    if (
      ts.isBinaryExpression(node) &&
      arithmeticOperators.has(node.operatorToken.kind) &&
      nodeReferencesAnyBinding(node, tainted, bindings)
    ) {
      suspicious = node
      return
    }
    if (ts.isConditionalExpression(node) && nodeReferencesAnyBinding(node.condition, tainted, bindings)) {
      suspicious = node
      return
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.some((argument) => nodeReferencesAnyBinding(argument, tainted, bindings))
    ) {
      const name = expressionCalleeName(node.expression)
      if (/(?:^|\.)(?:min|max|clamp|limit|bound|cap|truncate)$/iu.test(name)) {
        suspicious = node
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return suspicious
}

function unsafeTaintedUseBeforeTerminal(
  handler: WrapperFunction,
  tainted: ReadonlySet<LexicalBinding>,
  bindings: ReturnType<typeof createBindingIndex>,
  isTerminalCall: (call: ts.CallExpression) => boolean,
  isAllowedCall: (call: ts.CallExpression) => boolean,
  isAllowedAfterTerminalCall: (call: ts.CallExpression) => boolean = () => false
): ts.Node | undefined {
  if (handler.asteriskToken || handler.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    return handler
  }

  let terminalSeen = false
  let terminalCount = 0
  let unsafe: ts.Node | undefined
  const referencesTaint = (node: ts.Node | undefined): boolean =>
    !!node && nodeReferencesAnyBinding(node, tainted, bindings)
  const referencesTaintOutsideNestedFunction = (node: ts.Node | undefined): boolean => {
    if (!node) return false
    let found = false
    const visitOutside = (current: ts.Node): void => {
      if (found) return
      if (current !== node && isFunctionScope(current)) return
      if (ts.isIdentifier(current)) {
        const binding = bindings.resolve(current)
        if (binding && tainted.has(binding)) {
          found = true
          return
        }
      }
      ts.forEachChild(current, visitOutside)
    }
    visitOutside(node)
    return found
  }
  const visit = (node: ts.Node): void => {
    if (unsafe) return
    if (node !== handler && isFunctionScope(node)) {
      if (!terminalSeen && referencesTaint(node)) unsafe = node
      return
    }
    if (ts.isCallExpression(node)) {
      if (isTerminalCall(node)) {
        terminalCount += 1
        if (terminalCount > 1) unsafe = node
        terminalSeen = true
        return
      }
      if (isAllowedCall(node)) return
      if (
        (referencesTaintOutsideNestedFunction(node.expression) ||
          node.arguments.some(referencesTaintOutsideNestedFunction)) &&
        (!terminalSeen || !isAllowedAfterTerminalCall(node))
      ) {
        unsafe = node
        return
      }
    }
    if (!terminalSeen && ts.isVariableDeclaration(node) && referencesTaint(node.initializer)) {
      unsafe = node
      return
    }
    if (
      !terminalSeen &&
      ts.isBinaryExpression(node) &&
      ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      referencesTaint(node.right)
    ) {
      unsafe = node
      return
    }
    if (
      !terminalSeen &&
      ((ts.isReturnStatement(node) && referencesTaint(node.expression)) ||
        (ts.isThrowStatement(node) && referencesTaint(node.expression)) ||
        (ts.isYieldExpression(node) && referencesTaint(node.expression)) ||
        (ts.isAwaitExpression(node) && referencesTaint(node.expression)) ||
        (ts.isTaggedTemplateExpression(node) && referencesTaint(node)))
    ) {
      unsafe = node
      return
    }
    ts.forEachChild(node, visit)
  }
  if (handler.body) visit(handler.body)
  return unsafe
}

export interface ContextCountPatchOptions {
  trustedDefaultModules?: ReadonlySet<string>
  trustedContextGuardModules?: ReadonlySet<string>
  requireNumericOnChange?: boolean
  requireSliderValueState?: boolean
}

export function patchContextCountSource(
  content: string,
  fileName = 'context-count-source.tsx',
  options: ContextCountPatchOptions = {}
): ContextCountPatchResult {
  const parsed = parseSource(content, fileName)
  const diagnostics = [...parsed.diagnostics]
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { content, candidates: [], ignoredSliders: [], diagnostics, changed: 0 }
  }
  const bindings = createBindingIndex(parsed.sourceFile)
  const canonicalStates = collectCanonicalContextStates(parsed.sourceFile, bindings)
  const values = createContextValueResolver(bindings, canonicalStates)
  const resolver = createComponentResolver(parsed.sourceFile, bindings, options.trustedDefaultModules ?? new Set())
  const candidates: ContextCountCandidate[] = []
  const ignoredSliders: ContextCountIgnoredSlider[] = []
  const edits: Edit[] = []
  const diagnosticKeys = new Set<string>()

  const addDiagnostic = (diagnostic: ContextCountDiagnostic): void => {
    const key = `${diagnostic.code}:${diagnostic.start ?? -1}:${diagnostic.message}`
    if (diagnosticKeys.has(key)) return
    diagnosticKeys.add(key)
    diagnostics.push(diagnostic)
  }

  type ContextSetterState = 'none' | 'trusted' | 'other' | 'overridden'

  const inspectContextSetter = (
    opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement
  ): { states: Set<CanonicalContextState>; overridden: boolean } => {
    const states = new Map<string, ContextSetterState>([
      ['onChange', 'none'],
      ['onChangeComplete', 'none']
    ])
    const trustedByName = new Map<string, CanonicalContextState>()
    for (const property of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(property)) {
        for (const name of states.keys()) {
          const state = states.get(name)
          if (state === 'trusted' || state === 'overridden') {
            states.set(name, 'overridden')
            trustedByName.delete(name)
          }
        }
        continue
      }
      if (!ts.isJsxAttribute(property) || !ts.isIdentifier(property.name) || !states.has(property.name.text)) continue
      const expression = attributeExpression(property)
      let trustedState: CanonicalContextState | undefined
      if (expression && ts.isIdentifier(expression) && !bindings.isAmbiguous(expression)) {
        const binding = bindings.resolve(expression)
        trustedState = binding && canonicalStates.bySetter.get(binding)
      }
      states.set(property.name.text, trustedState ? 'trusted' : 'other')
      if (trustedState) trustedByName.set(property.name.text, trustedState)
      else trustedByName.delete(property.name.text)
    }
    return {
      states: new Set(trustedByName.values()),
      overridden: [...states.values()].some((state) => state === 'overridden')
    }
  }

  const resolveOpening = (opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): ComponentResolution => {
    const component = jsxNameText(opening.tagName)
    let resolution = resolver.resolveTag(opening.tagName)
    if (resolution.kind === 'unknown' && component === 'input') {
      const inputType = attributeStringValue(attributeByName(opening, 'type')[0])?.toLowerCase()
      if (inputType === 'number') resolution = { kind: 'numeric', reason: 'intrinsic:input[type=number]' }
      else if (inputType === 'range') resolution = { kind: 'slider', reason: 'intrinsic:input[type=range]' }
    }
    return resolution
  }

  const isTrustedContextGuardCall = (
    call: ts.CallExpression,
    handlerParameters: ReadonlySet<LexicalBinding>
  ): boolean => {
    const callee = unwrapExpression(call.expression)
    if (!ts.isIdentifier(callee) || bindings.isAmbiguous(callee) || call.arguments.length !== 1) return false
    const calleeBinding = bindings.resolve(callee)
    if (
      !calleeBinding ||
      !ts.isImportSpecifier(calleeBinding.declaration) ||
      importedName(calleeBinding.declaration) !== 'isValidContextCount' ||
      !(options.trustedContextGuardModules ?? new Set()).has(importedModule(calleeBinding.declaration) ?? '')
    ) {
      return false
    }
    const argument = unwrapExpression(call.arguments[0])
    return (
      ts.isIdentifier(argument) && !!bindings.resolve(argument) && handlerParameters.has(bindings.resolve(argument)!)
    )
  }

  const isSafeHandlerGuard = (expression: ts.Expression, handlerParameters: ReadonlySet<LexicalBinding>): boolean => {
    const current = unwrapExpression(expression)
    if (!nodeReferencesAnyBinding(current, handlerParameters, bindings)) return true
    // 只有经过实际模块解析和无上界契约校验的正向 guard 才能证明写入值安全。
    // 否定、null 比较、逻辑组合和不透明条件都 fail-closed：它们可能把未验证值
    // 带入 canonical state，或让上游在 guard 的另一分支恢复隐藏限幅。
    return ts.isCallExpression(current) && isTrustedContextGuardCall(current, handlerParameters)
  }

  const validatedSetterCalls = new Set<ts.CallExpression>()
  const validatedNumericSetterAttributes = new Set<ts.JsxAttribute>()

  const inspectNumericBehavior = (
    opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    state: CanonicalContextState | undefined,
    context?: WrapperContext
  ): ContextCountDiagnostic | undefined => {
    for (const property of opening.attributes.properties) {
      if (!ts.isJsxSpreadAttribute(property)) continue
      // 仅允许包装内透明 props 原样 spread；其他 spread 都可能注入 parser/onChange/max
      if (!(context && isTrustedPropsExpression(property.expression, context, bindings))) {
        return diagnosticAtOpening(
          parsed.sourceFile,
          opening,
          'UNRESOLVED_NUMERIC_BEHAVIOR',
          `${jsxNameText(opening.tagName)} 使用了 spread，无法证明 parser 或 onChange 不会被注入或覆盖`
        )
      }
    }
    if (attributeByName(opening, 'parser').length > 0) {
      return diagnosticAtOpening(
        parsed.sourceFile,
        opening,
        'UNRESOLVED_NUMERIC_BEHAVIOR',
        `${jsxNameText(opening.tagName)} 声明了 parser，无法证明输入值不会在 max 之外再次限幅`
      )
    }

    const onChange = attributeByName(opening, 'onChange').at(-1)
    if (!onChange) {
      return options.requireNumericOnChange
        ? diagnosticAtOpening(
            parsed.sourceFile,
            opening,
            'UNRESOLVED_NUMERIC_BEHAVIOR',
            `${jsxNameText(opening.tagName)} 缺少 onChange，受控 contextCount 无法证明可持久写入`
          )
        : undefined
    }
    const expression = attributeExpression(onChange)
    if (!expression || !state?.setterBinding) {
      return diagnosticAtOpening(
        parsed.sourceFile,
        opening,
        'UNRESOLVED_NUMERIC_BEHAVIOR',
        `${jsxNameText(opening.tagName)} 的 onChange 无法关联到唯一 canonical contextCount setter`
      )
    }

    const direct = unwrapExpression(expression)
    if (ts.isIdentifier(direct) && bindings.resolve(direct) === state.setterBinding) {
      validatedNumericSetterAttributes.add(onChange)
      return undefined
    }
    const handler = localFunctionForExpression(direct, bindings)
    const parameter = handler?.parameters[0]
    if (
      !handler ||
      handler.parameters.length !== 1 ||
      !parameter ||
      !ts.isIdentifier(parameter.name) ||
      !!parameter.initializer ||
      !!parameter.questionToken ||
      !!parameter.dotDotDotToken
    ) {
      return diagnosticAtOpening(
        parsed.sourceFile,
        opening,
        'UNRESOLVED_NUMERIC_BEHAVIOR',
        `${jsxNameText(opening.tagName)} 的 onChange 不是可静态证明透明的本地函数`
      )
    }
    const parameterBinding = bindings.bindingOf(parameter.name)
    if (!parameterBinding || bindingHasWrite(parameterBinding, bindings)) {
      return diagnosticAtOpening(
        parsed.sourceFile,
        opening,
        'UNRESOLVED_NUMERIC_BEHAVIOR',
        `${jsxNameText(opening.tagName)} 的 onChange 参数无法解析、形状不唯一或在写入前被重赋`
      )
    }
    const handlerParameters = new Set([parameterBinding])
    const isDirectParameterCommit = (call: ts.CallExpression): boolean => {
      const callee = unwrapExpression(call.expression)
      if (!ts.isIdentifier(callee) || bindings.resolve(callee) !== state.setterBinding || call.arguments.length !== 1) {
        return false
      }
      const argument = unwrapExpression(call.arguments[0])
      return (
        ts.isIdentifier(argument) && !!bindings.resolve(argument) && handlerParameters.has(bindings.resolve(argument)!)
      )
    }
    const unsafeTaintedFlow = unsafeTaintedUseBeforeTerminal(
      handler,
      handlerParameters,
      bindings,
      isDirectParameterCommit,
      (call) => isTrustedContextGuardCall(call, handlerParameters),
      // 原样提交后，允许同一参数参与持久化/定时器等副作用；但仍拒绝终点后的限幅变换
      (call) => !containsHiddenUpperBound(call, handlerParameters, bindings)
    )
    if (unsafeTaintedFlow) {
      return diagnosticAtNode(
        parsed.sourceFile,
        unsafeTaintedFlow,
        'HIDDEN_CONTEXT_LIMIT',
        `${jsxNameText(opening.tagName)} 的 onChange 在原样写入前使用了不透明 helper、别名或异步控制流`
      )
    }
    const suspicious = handler.body && containsHiddenUpperBound(handler.body, handlerParameters, bindings)
    if (suspicious) {
      return diagnosticAtNode(
        parsed.sourceFile,
        suspicious,
        'HIDDEN_CONTEXT_LIMIT',
        `${jsxNameText(opening.tagName)} 的 onChange 对输入值执行了条件、算术或限幅调用`
      )
    }

    let unsafeGuard: ts.Expression | undefined
    let commitsOriginalValue = false
    const isDirectCommitCall = (node: ts.Node): node is ts.CallExpression => {
      return ts.isCallExpression(node) && isDirectParameterCommit(node)
    }
    const containsDirectCommit = (root: ts.Node): boolean => {
      let found = false
      const visit = (node: ts.Node): void => {
        if (found || (node !== root && isFunctionScope(node))) return
        if (isDirectCommitCall(node)) {
          found = true
          return
        }
        ts.forEachChild(node, visit)
      }
      visit(root)
      return found
    }
    const unsafeControlForCommit = (commit: ts.CallExpression): ts.Expression | undefined => {
      if (containingFunction(commit) !== handler) return commit
      for (let current: ts.Node | undefined = commit.parent; current && current !== handler; current = current.parent) {
        if (ts.isIfStatement(current)) {
          const condition = current.expression
          if (!nodeReferencesAnyBinding(condition, handlerParameters, bindings)) continue
          const inThen = nodeContains(current.thenStatement, commit)
          const inElse = !!current.elseStatement && nodeContains(current.elseStatement, commit)
          if (!inThen || inElse || !isSafeHandlerGuard(condition, handlerParameters)) return condition
          continue
        }
        if (
          ts.isConditionalExpression(current) &&
          nodeReferencesAnyBinding(current.condition, handlerParameters, bindings)
        ) {
          return current.condition
        }
        if (
          ts.isSwitchStatement(current) &&
          nodeReferencesAnyBinding(current.expression, handlerParameters, bindings)
        ) {
          return current.expression
        }
        let loopCondition: ts.Expression | undefined
        if (ts.isWhileStatement(current) || ts.isDoStatement(current)) loopCondition = current.expression
        else if (ts.isForStatement(current)) loopCondition = current.condition ?? undefined
        else if (ts.isForInStatement(current) || ts.isForOfStatement(current)) loopCondition = current.expression
        if (loopCondition && nodeReferencesAnyBinding(loopCondition, handlerParameters, bindings)) {
          return loopCondition
        }
        if (
          ts.isBinaryExpression(current) &&
          (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
          nodeReferencesAnyBinding(current, handlerParameters, bindings)
        ) {
          return current
        }
      }
      return undefined
    }
    const inspectHandler = (node: ts.Node): void => {
      if (
        ts.isIfStatement(node) &&
        nodeReferencesAnyBinding(node.expression, handlerParameters, bindings) &&
        (!isSafeHandlerGuard(node.expression, handlerParameters) || !containsDirectCommit(node.thenStatement))
      ) {
        unsafeGuard ??= node.expression
      }
      if (isDirectCommitCall(node)) {
        const unsafeControl = unsafeControlForCommit(node)
        if (unsafeControl) unsafeGuard ??= unsafeControl
        else {
          commitsOriginalValue = true
          validatedSetterCalls.add(node)
        }
      }
      ts.forEachChild(node, inspectHandler)
    }
    if (handler.body) inspectHandler(handler.body)
    if (unsafeGuard) {
      return diagnosticAtNode(
        parsed.sourceFile,
        unsafeGuard,
        'HIDDEN_CONTEXT_LIMIT',
        `${jsxNameText(opening.tagName)} 的 onChange 使用了无法证明无有限上界的条件`
      )
    }
    if (!commitsOriginalValue) {
      return diagnosticAtOpening(
        parsed.sourceFile,
        opening,
        'UNRESOLVED_NUMERIC_BEHAVIOR',
        `${jsxNameText(opening.tagName)} 的 onChange 未将回调参数原样写入同一 canonical contextCount setter`
      )
    }
    return undefined
  }

  interface TraceResult {
    maxAttributes: ts.JsxAttribute[]
    unresolvedMax: boolean
  }

  const traceInvocation = (
    opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    state: OpeningState,
    context: WrapperContext | undefined,
    stack = new Set<WrapperFunction>()
  ): TraceResult => {
    const component = jsxNameText(opening.tagName)
    const insideWrapper = context !== undefined
    const result: TraceResult = {
      maxAttributes: insideWrapper ? [] : [...state.maxAttributes],
      unresolvedMax: state.maxUnknown
    }
    if (insideWrapper && state.maxAttributes.length > 0) {
      result.unresolvedMax = true
      addDiagnostic(
        diagnosticAtOpening(
          parsed.sourceFile,
          opening,
          'UNRESOLVED_WRAPPER_MAX',
          `${component} 在本地包装组件定义中声明了 max；修改该定义可能影响非 contextCount 调用，拒绝自动写入`
        )
      )
    }
    if (state.maxUnknown) {
      addDiagnostic(
        diagnosticAtOpening(
          parsed.sourceFile,
          opening,
          context ? 'UNRESOLVED_WRAPPER_MAX' : 'UNRESOLVED_SPREAD_MAX',
          context
            ? `${component} 的包装属性流可能包含 max，无法证明移除后限制已解除；拒绝自动写入`
            : `${component} 含有 spread 属性，无法静态证明其中没有额外 max；拒绝自动写入`
        )
      )
    }

    const wrappers = resolver.wrapperFunctions(opening.tagName)
    for (const wrapper of wrappers) {
      if (stack.has(wrapper)) {
        result.unresolvedMax = true
        addDiagnostic(
          diagnosticAtOpening(
            parsed.sourceFile,
            opening,
            'UNRESOLVED_WRAPPER_CYCLE',
            `${component} 的包装组件属性流存在循环，无法确认 max 来源`
          )
        )
        continue
      }

      const wrapperContext = createWrapperContext(wrapper, state.value, state.contextStates, state.maxUnknown, bindings)
      if (wrapperContext.unsafeReason) {
        result.unresolvedMax = true
        addDiagnostic(
          diagnosticAtOpening(
            parsed.sourceFile,
            opening,
            'UNRESOLVED_WRAPPER_MAX',
            `${component} 不是可证明的透明包装：${wrapperContext.unsafeReason}；拒绝自动写入`
          )
        )
        continue
      }
      let followedValue = false
      const nextStack = new Set(stack).add(wrapper)
      for (const nested of collectReturnedOpeningElements(wrapper)) {
        const nestedState = openingState(nested, wrapperContext, bindings, values)
        if (nestedState.value !== 'context') continue
        followedValue = true
        const nestedComponent = jsxNameText(nested.tagName)
        const nestedResolution = resolveOpening(nested)
        if (nestedResolution.kind === 'slider') {
          result.unresolvedMax = true
          addDiagnostic(
            diagnosticAtOpening(
              parsed.sourceFile,
              nested,
              'UNRESOLVED_WRAPPER_COMPONENT',
              `${component} 将 value 转发到 Slider ${nestedComponent}，与数字输入组件识别结果冲突`
            )
          )
          continue
        }
        if (nestedResolution.kind !== 'numeric') {
          if (
            nestedState.maxAttributes.length > 0 ||
            nestedState.maxUnknown ||
            resolver.wrapperMayContainMax(nested.tagName)
          ) {
            result.unresolvedMax = true
            addDiagnostic(
              diagnosticAtOpening(
                parsed.sourceFile,
                nested,
                'UNRESOLVED_WRAPPER_COMPONENT',
                `无法确认 ${nestedComponent} 的包装属性流最终进入数字输入组件，且其中可能包含 max`
              )
            )
          }
          continue
        }
        const nestedBehavior = inspectNumericBehavior(nested, [...nestedState.contextStates][0], wrapperContext)
        if (nestedBehavior) {
          result.unresolvedMax = true
          addDiagnostic(nestedBehavior)
          continue
        }
        const nestedResult = traceInvocation(nested, nestedState, wrapperContext, nextStack)
        result.maxAttributes.push(...nestedResult.maxAttributes)
        result.unresolvedMax ||= nestedResult.unresolvedMax
      }

      if (!followedValue) {
        result.unresolvedMax = true
        addDiagnostic(
          diagnosticAtOpening(
            parsed.sourceFile,
            opening,
            'UNRESOLVED_WRAPPER_VALUE',
            `无法证明 ${component} 将调用点的 value 转发到其数字输入组件；为避免静默遗漏内部 max，拒绝自动写入`
          )
        )
      }
    }

    return result
  }

  for (const opening of collectOpeningElements(parsed.sourceFile)) {
    const state = openingState(opening, undefined, bindings, values)
    const resolution = resolveOpening(opening)
    const setter =
      resolution.kind === 'slider'
        ? inspectContextSetter(opening)
        : { states: new Set<CanonicalContextState>(), overridden: false }
    if (resolution.kind === 'slider' && setter.overridden) {
      addDiagnostic(
        diagnosticAtOpening(
          parsed.sourceFile,
          opening,
          'UNRESOLVED_SLIDER_SETTER',
          `${jsxNameText(opening.tagName)} 的 contextCount setter 可能被后置 spread 覆盖，无法确认受保护的 onChange 仍然生效`
        )
      )
      continue
    }
    const contextSlider = resolution.kind === 'slider' && setter.states.size > 0
    const containsContext = state.contextStates.size > 0 || state.value === 'context'
    if (!containsContext && !state.contextValueUncertain && !contextSlider) continue

    const valueAttribute = attributeByName(opening, 'value').at(-1)
    const value = attributeExpression(valueAttribute)

    const component = jsxNameText(opening.tagName)
    const start = opening.getStart(parsed.sourceFile)
    const location = parsed.sourceFile.getLineAndCharacterOfPosition(start)
    const common = {
      component,
      start,
      end: opening.end,
      line: location.line + 1,
      column: location.character + 1,
      valueExpression: value?.getText(parsed.sourceFile) ?? '<spread>',
      hasMax: state.maxAttributes.length > 0
    }

    if (state.contextValueUncertain && resolution.kind === 'numeric') {
      addDiagnostic({
        severity: 'error',
        code: 'UNRESOLVED_SPREAD_VALUE',
        message: `${component} 在 contextCount 之后包含无法解析的 spread，最终 value 可能已被覆盖；拒绝自动写入`,
        start,
        line: common.line,
        column: common.column
      })
      continue
    }

    if (resolution.kind === 'numeric' && state.contextStates.size > 0 && state.value !== 'context') {
      addDiagnostic({
        severity: 'error',
        code: 'UNRESOLVED_CONTEXT_VALUE',
        message: `${component} 的 value 对 contextCount 使用了条件、算术、调用或其他无法证明无损的变换；拒绝自动移除 max`,
        start,
        line: common.line,
        column: common.column
      })
      continue
    }

    if (state.contextStates.size > 1) {
      addDiagnostic({
        severity: 'error',
        code: 'AMBIGUOUS_CONTEXT_STATE',
        message: `${component} 的 value 同时依赖多个 canonical contextCount state，无法建立唯一配对`,
        start,
        line: common.line,
        column: common.column
      })
      continue
    }

    if (resolution.kind === 'slider') {
      if (setter.states.size !== 1) {
        addDiagnostic(
          diagnosticAtOpening(
            parsed.sourceFile,
            opening,
            'UNRESOLVED_SLIDER_SETTER',
            `${component} 必须直接绑定唯一 canonical contextCount setter，不能只凭 value 名称计入保护数量`
          )
        )
        continue
      }
      const sliderState = [...setter.states][0]
      const valueState = [...state.contextStates][0]
      if (options.requireSliderValueState && !valueState) {
        addDiagnostic(
          diagnosticAtOpening(
            parsed.sourceFile,
            opening,
            'UNRESOLVED_SLIDER_VALUE',
            `${component} 的 value 必须依赖与 onChange setter 相同的唯一 canonical contextCount state`
          )
        )
        continue
      }
      if (valueState && valueState !== sliderState) {
        addDiagnostic(
          diagnosticAtOpening(
            parsed.sourceFile,
            opening,
            'MISMATCHED_SLIDER_STATE',
            `${component} 的 value 与 onChange setter 属于不同 canonical contextCount state`
          )
        )
        continue
      }
      ignoredSliders.push({
        ...common,
        reason: resolution.reason,
        stateKey: sliderState.key,
        stateOrigin: sliderState.origin
      })
      continue
    }

    if (resolution.kind !== 'numeric') {
      const mayContainMax =
        state.maxAttributes.length > 0 || state.maxUnknown || resolver.wrapperMayContainMax(opening.tagName)
      addDiagnostic({
        severity: 'error',
        code: 'UNRESOLVED_COMPONENT',
        message: `无法确认 ${component} 是受支持的数字输入组件或 Slider；该组件绑定 contextCount，无法证明自动补丁不会${mayContainMax ? '遗漏或误改 max' : '遗漏内部限制'}（识别依据：${resolution.reason}）`,
        start,
        line: common.line,
        column: common.column
      })
      continue
    }

    const numericState = [...state.contextStates][0]
    const behaviorDiagnostic = inspectNumericBehavior(opening, numericState)
    if (behaviorDiagnostic) {
      addDiagnostic(behaviorDiagnostic)
      continue
    }

    const traced = traceInvocation(opening, state, undefined)
    const maxAttributes = traced.maxAttributes.filter(
      (attribute, index, all) => all.findIndex((candidate) => candidate.getStart() === attribute.getStart()) === index
    )
    const candidate: ContextCountCandidate = {
      ...common,
      hasMax: maxAttributes.length > 0,
      maxCount: maxAttributes.length,
      resolution: resolution.reason,
      unresolvedMax: traced.unresolvedMax,
      hasOnChange: attributeByName(opening, 'onChange').length > 0,
      ...(numericState
        ? {
            stateKey: numericState.key,
            stateOrigin: numericState.origin
          }
        : {})
    }
    candidates.push(candidate)
    for (const attribute of maxAttributes) edits.push(removalRange(content, attribute))
  }

  const isTrustedResetArgument = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression)
    if (ts.isIdentifier(current)) {
      if (bindings.isAmbiguous(current)) return false
      const binding = bindings.resolve(current)
      if (!binding) return false
      return (
        ts.isImportSpecifier(binding.declaration) &&
        importedName(binding.declaration) === 'DEFAULT_CONTEXTCOUNT' &&
        importedModule(binding.declaration) === '@renderer/config/constant'
      )
    }
    if (ts.isPropertyAccessExpression(current) && current.name.text === 'contextCount') {
      const root = unwrapExpression(current.expression)
      if (!ts.isIdentifier(root) || bindings.isAmbiguous(root)) return false
      const binding = bindings.resolve(root)
      return (
        !!binding &&
        ts.isImportSpecifier(binding.declaration) &&
        importedName(binding.declaration) === 'DEFAULT_ASSISTANT_SETTINGS' &&
        importedModule(binding.declaration) === '@renderer/services/AssistantService'
      )
    }
    return false
  }

  for (const canonicalState of canonicalStates.all) {
    if (!canonicalState.setterBinding) continue
    const inspectSetterReferences = (node: ts.Node): void => {
      if (
        !ts.isIdentifier(node) ||
        node === canonicalState.setterBinding?.identifier ||
        bindings.resolve(node) !== canonicalState.setterBinding
      ) {
        ts.forEachChild(node, inspectSetterReferences)
        return
      }

      const parent = node.parent
      if (ts.isCallExpression(parent) && parent.expression === node) {
        if (
          !validatedSetterCalls.has(parent) &&
          (parent.arguments.length !== 1 || !isTrustedResetArgument(parent.arguments[0]))
        ) {
          addDiagnostic(
            diagnosticAtNode(
              parsed.sourceFile,
              parent,
              'HIDDEN_CONTEXT_LIMIT',
              `${node.text} 的写入参数不是可证明无损的回调值或受信默认值`
            )
          )
        }
        return
      }

      if (ts.isJsxExpression(parent) && parent.expression === node && ts.isJsxAttribute(parent.parent)) {
        const attribute = parent.parent
        const opening = attribute.parent.parent
        if (
          ts.isIdentifier(attribute.name) &&
          (attribute.name.text === 'onChange' || attribute.name.text === 'onChangeComplete') &&
          (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
          (resolveOpening(opening).kind === 'slider' || validatedNumericSetterAttributes.has(attribute))
        ) {
          return
        }
      }

      addDiagnostic(
        diagnosticAtNode(
          parsed.sourceFile,
          node,
          'UNRESOLVED_CONTEXT_SETTER_USE',
          `${node.text} 被传给无法证明透明的函数、别名或组件，可能在其他路径恢复有限上界`
        )
      )
    }
    inspectSetterReferences(parsed.sourceFile)
  }

  let patchedContent = content
  const uniqueEdits = edits
    .filter(
      (edit, index, all) =>
        all.findIndex((candidate) => candidate.start === edit.start && candidate.end === edit.end) === index
    )
    .sort((left, right) => right.start - left.start)
  for (const edit of uniqueEdits) patchedContent = patchedContent.slice(0, edit.start) + patchedContent.slice(edit.end)

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) patchedContent = content

  return {
    content: patchedContent,
    candidates,
    ignoredSliders,
    diagnostics,
    changed: diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 0 : uniqueEdits.length
  }
}

interface TrustedModuleResolution {
  filePath?: string
  importers: Set<string>
  diagnostics: ContextCountDiagnostic[]
}

function pathIdentity(filePath: string): string {
  const normalized = path.normalize(filePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

interface CompilerOptionsResolution {
  options?: ts.CompilerOptions
  diagnostics: ContextCountDiagnostic[]
}

function compilerOptionsForRoot(root: string): CompilerOptionsResolution {
  const diagnostics: ContextCountDiagnostic[] = []
  for (let directory = path.resolve(root); ; directory = path.dirname(directory)) {
    for (const name of ['tsconfig.web.json', 'tsconfig.json']) {
      const configPath = path.join(directory, name)
      if (!fs.existsSync(configPath)) continue
      const read = ts.readConfigFile(configPath, ts.sys.readFile)
      if (read.error) {
        diagnostics.push({
          severity: 'error',
          code: 'TRUSTED_MODULE_RESOLUTION',
          message: `无法读取 ${path.relative(root, configPath)}：${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`
        })
        return { diagnostics }
      }
      const config = read.config as Record<string, unknown> | undefined
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        diagnostics.push({
          severity: 'error',
          code: 'TRUSTED_MODULE_RESOLUTION',
          message: `${path.relative(root, configPath)} 的配置根节点不是对象`
        })
        return { diagnostics }
      }
      const compilerOptions = config.compilerOptions
      if (
        compilerOptions !== undefined &&
        (typeof compilerOptions !== 'object' || compilerOptions === null || Array.isArray(compilerOptions))
      ) {
        diagnostics.push({
          severity: 'error',
          code: 'TRUSTED_MODULE_RESOLUTION',
          message: `${path.relative(root, configPath)} 的 compilerOptions 不是对象`
        })
        return { diagnostics }
      }
      const extendsValue = config.extends
      if (extendsValue !== undefined) {
        const invalidExtends =
          typeof extendsValue !== 'string' ||
          extendsValue.trim().length === 0 ||
          path.isAbsolute(extendsValue) ||
          extendsValue.startsWith('.') ||
          /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(extendsValue)
        if (invalidExtends) {
          diagnostics.push({
            severity: 'error',
            code: 'TRUSTED_MODULE_RESOLUTION',
            message: `${path.relative(root, configPath)} 的 extends 必须是可忽略的外部包名，不能是相对路径、绝对路径、URL 或空值`
          })
          return { diagnostics }
        }
        if (
          !compilerOptions ||
          typeof compilerOptions !== 'object' ||
          (!Object.prototype.hasOwnProperty.call(compilerOptions, 'paths') &&
            !Object.prototype.hasOwnProperty.call(compilerOptions, 'baseUrl'))
        ) {
          diagnostics.push({
            severity: 'error',
            code: 'TRUSTED_MODULE_RESOLUTION',
            message: `${path.relative(root, configPath)} 依赖外部 extends 提供本地路径语义；为避免隔离环境漂移，必须在当前 compilerOptions 显式声明 paths 或 baseUrl`
          })
          return { diagnostics }
        }
      }
      const converted = ts.convertCompilerOptionsFromJson(compilerOptions ?? {}, directory, configPath)
      if (converted.errors.length > 0) {
        diagnostics.push({
          severity: 'error',
          code: 'TRUSTED_MODULE_RESOLUTION',
          message: `${path.relative(root, configPath)} 的本地 compilerOptions 无法转换：${converted.errors
            .map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' '))
            .join('; ')}`
        })
        return { diagnostics }
      }
      ;(converted.options as ts.CompilerOptions & { pathsBasePath?: string }).pathsBasePath = directory
      return { options: converted.options, diagnostics }
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
  }
  return {
    options: {
      baseUrl: path.resolve(root),
      paths: { '@renderer/*': ['*'] },
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
      jsx: ts.JsxEmit.Preserve
    },
    diagnostics
  }
}

function resolveTrustedSourceModule(
  root: string,
  sourceFiles: string[],
  moduleSpecifier: string,
  expectedRelativePath: string,
  acceptsImport: (clause: ts.ImportClause) => boolean
): TrustedModuleResolution {
  const importers = new Set<string>()
  for (const filePath of sourceFiles) {
    const content = fs.readFileSync(filePath, 'utf8')
    const parsed = parseSource(content, filePath)
    if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) continue
    for (const statement of parsed.sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        statement.importClause &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === moduleSpecifier &&
        acceptsImport(statement.importClause)
      ) {
        importers.add(pathIdentity(path.resolve(filePath)))
      }
    }
  }
  if (importers.size === 0) return { importers, diagnostics: [] }

  const diagnostics: ContextCountDiagnostic[] = []
  const rootPath = path.resolve(root)
  const expectedPath = path.resolve(rootPath, expectedRelativePath)
  let rootRealPath: string
  let expectedRealPath: string
  try {
    rootRealPath = path.resolve(fs.realpathSync.native(rootPath))
    expectedRealPath = path.resolve(fs.realpathSync.native(expectedPath))
  } catch {
    diagnostics.push({
      severity: 'error',
      code: 'TRUSTED_MODULE_RESOLUTION',
      message: `${moduleSpecifier} 的预期实现 ${expectedRelativePath} 无法进行真实路径校验`
    })
    return { importers, diagnostics }
  }
  const expectedCanonicalPath = path.resolve(rootRealPath, path.relative(rootPath, expectedPath))
  if (
    !isPathWithin(rootPath, expectedPath) ||
    !isPathWithin(rootRealPath, expectedCanonicalPath) ||
    pathIdentity(expectedRealPath) !== pathIdentity(expectedCanonicalPath) ||
    !fs.lstatSync(expectedPath).isFile()
  ) {
    diagnostics.push({
      severity: 'error',
      code: 'TRUSTED_MODULE_RESOLUTION',
      message: `${moduleSpecifier} 的预期实现 ${expectedRelativePath} 不存在、不是普通文件、位于 root 外或经过符号链接/junction，拒绝继续同步`
    })
    return { importers, diagnostics }
  }

  const compilerResolution = compilerOptionsForRoot(root)
  diagnostics.push(...compilerResolution.diagnostics)
  if (
    !compilerResolution.options ||
    compilerResolution.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
  ) {
    return { importers, diagnostics }
  }
  const compilerOptions = compilerResolution.options
  const expectedIdentity = pathIdentity(expectedCanonicalPath)
  let resolvedPath: string | undefined
  for (const importerIdentity of importers) {
    const resolved = ts.resolveModuleName(moduleSpecifier, importerIdentity, compilerOptions, ts.sys).resolvedModule
    if (!resolved || resolved.isExternalLibraryImport) {
      diagnostics.push({
        severity: 'error',
        code: 'TRUSTED_MODULE_RESOLUTION',
        message: `${moduleSpecifier} 无法从 ${path.relative(root, importerIdentity)} 解析到 renderer 源文件`
      })
      continue
    }
    const candidate = path.resolve(resolved.resolvedFileName)
    let candidateRealPath: string | undefined
    try {
      candidateRealPath = path.resolve(fs.realpathSync.native(candidate))
    } catch {
      candidateRealPath = undefined
    }
    const candidateCanonicalPath = isPathWithin(rootPath, candidate)
      ? path.resolve(rootRealPath, path.relative(rootPath, candidate))
      : isPathWithin(rootRealPath, candidate)
        ? candidate
        : undefined
    if (
      !candidateCanonicalPath ||
      !candidateRealPath ||
      !isPathWithin(rootRealPath, candidateRealPath) ||
      pathIdentity(candidateRealPath) !== pathIdentity(candidateCanonicalPath) ||
      !fs.existsSync(candidate) ||
      !fs.lstatSync(candidate).isFile()
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'TRUSTED_MODULE_RESOLUTION',
        message: `${moduleSpecifier} 从 ${path.relative(root, importerIdentity)} 解析到的文件不存在、不是普通文件、位于 root 外或经过符号链接/junction`
      })
      continue
    }
    const candidateIdentity = pathIdentity(candidateCanonicalPath)
    if (candidateIdentity !== expectedIdentity) {
      diagnostics.push({
        severity: 'error',
        code: 'TRUSTED_MODULE_RESOLUTION',
        message: `${moduleSpecifier} 从 ${path.relative(root, importerIdentity)} 实际解析到 ${path.relative(root, candidate)}，与预期 ${expectedRelativePath} 不同，可能发生 shadow 或 paths 别名漂移`
      })
      continue
    }
    resolvedPath ??= expectedRealPath
  }

  return { filePath: diagnostics.length === 0 ? resolvedPath : undefined, importers, diagnostics }
}

function validateEditableNumberContract(filePath: string): ContextCountDiagnostic[] {
  if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
    return [
      {
        severity: 'error',
        code: 'TRUSTED_COMPONENT_CONTRACT',
        message: `${TRUSTED_EDITABLE_NUMBER_MODULE} 的实现文件不存在或不是普通文件，拒绝继续同步`
      }
    ]
  }

  const content = fs.readFileSync(filePath, 'utf8')
  const parsed = parseSource(content, filePath)
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return parsed.diagnostics

  const bindings = createBindingIndex(parsed.sourceFile)
  const resolver = createComponentResolver(parsed.sourceFile, bindings)
  const exportAssignments = parsed.sourceFile.statements.filter(
    (statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && !statement.isExportEquals
  )
  if (exportAssignments.length !== 1) {
    return [
      {
        severity: 'error',
        code: 'TRUSTED_COMPONENT_CONTRACT',
        message: 'EditableNumber 必须有唯一的 export default 实现'
      }
    ]
  }

  const exportedExpression = unwrapExpression(exportAssignments[0].expression)
  let exportedWrapper: WrapperFunction | undefined
  if (ts.isArrowFunction(exportedExpression) || ts.isFunctionExpression(exportedExpression)) {
    exportedWrapper = exportedExpression
  } else if (ts.isIdentifier(exportedExpression)) {
    const exportedBinding = bindings.resolve(exportedExpression)
    const declaration = exportedBinding?.declaration
    if (
      exportedBinding?.readonly &&
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
    ) {
      exportedWrapper = declaration.initializer
    }
  }
  if (!exportedWrapper) {
    return [
      {
        severity: 'error',
        code: 'TRUSTED_COMPONENT_CONTRACT',
        message: 'EditableNumber 的 export default 不是可静态检查的函数组件'
      }
    ]
  }

  const contractError = (
    message: string,
    opening?: ts.JsxOpeningElement | ts.JsxSelfClosingElement
  ): ContextCountDiagnostic =>
    opening
      ? diagnosticAtOpening(parsed.sourceFile, opening, 'TRUSTED_COMPONENT_CONTRACT', message)
      : { severity: 'error', code: 'TRUSTED_COMPONENT_CONTRACT', message }

  const isDirectParameterProperty = (identifier: ts.Identifier, propertyName: string): boolean => {
    if (bindings.isAmbiguous(identifier)) return false
    const binding = bindings.resolve(identifier)
    const element = binding && bindingElementForIdentifier(binding.identifier)
    return (
      !!binding &&
      binding.scope === exportedWrapper &&
      ts.isParameter(binding.declaration) &&
      !!element &&
      ts.isObjectBindingPattern(element.parent) &&
      element.parent.parent === binding.declaration &&
      !binding.declaration.initializer &&
      !binding.declaration.dotDotDotToken &&
      !binding.declaration.questionToken &&
      !element.dotDotDotToken &&
      !element.initializer &&
      binding.propertyName === propertyName &&
      !bindingHasWrite(binding, bindings)
    )
  }

  const isTrustedScalarExpression = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression)
    if (
      current.kind === ts.SyntaxKind.NullKeyword ||
      current.kind === ts.SyntaxKind.TrueKeyword ||
      current.kind === ts.SyntaxKind.FalseKeyword ||
      ts.isStringLiteralLike(current) ||
      ts.isNumericLiteral(current)
    ) {
      return true
    }
    if (ts.isIdentifier(current)) {
      return (
        current.text === 'undefined' ||
        isDirectParameterProperty(current, 'value') ||
        isDirectParameterProperty(current, 'placeholder')
      )
    }
    return (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      isTrustedScalarExpression(current.left) &&
      isTrustedScalarExpression(current.right)
    )
  }

  const isTrustedFormatterCall = (call: ts.CallExpression): boolean => {
    const formatter = unwrapExpression(call.expression)
    return (
      ts.isIdentifier(formatter) &&
      isDirectParameterProperty(formatter, 'formatter') &&
      call.arguments.length === 1 &&
      !ts.isSpreadElement(call.arguments[0]) &&
      isTrustedScalarExpression(call.arguments[0])
    )
  }

  const inspectRenderExpression = (expression: ts.Expression, requiredBranch: boolean): ts.Expression | undefined => {
    const current = unwrapExpression(expression)
    if (ts.isJsxElement(current) || ts.isJsxFragment(current)) {
      for (const child of current.children) {
        if (ts.isJsxExpression(child) && child.expression) {
          const unresolved = inspectRenderExpression(child.expression, false)
          if (unresolved) return unresolved
        } else if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
          const unresolved = inspectRenderExpression(child, false)
          if (unresolved) return unresolved
        }
      }
      return undefined
    }
    if (ts.isJsxSelfClosingElement(current)) return undefined
    if (ts.isConditionalExpression(current)) {
      return (
        inspectRenderExpression(current.whenTrue, requiredBranch) ??
        inspectRenderExpression(current.whenFalse, requiredBranch)
      )
    }
    if (ts.isBinaryExpression(current)) {
      if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return inspectRenderExpression(current.right, requiredBranch)
      }
      if (
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return (
          inspectRenderExpression(current.left, requiredBranch) ??
          inspectRenderExpression(current.right, requiredBranch)
        )
      }
      return current
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) {
        if (!ts.isSpreadElement(element)) {
          const unresolved = inspectRenderExpression(element, requiredBranch)
          if (unresolved) return unresolved
        } else return current
      }
      return undefined
    }
    if (ts.isCallExpression(current)) {
      return requiredBranch || !isTrustedFormatterCall(current) ? current : undefined
    }
    if (ts.isIdentifier(current)) {
      if (current.text === 'undefined') return undefined
      return requiredBranch || !isTrustedScalarExpression(current) ? current : undefined
    }
    if (
      current.kind === ts.SyntaxKind.NullKeyword ||
      current.kind === ts.SyntaxKind.TrueKeyword ||
      current.kind === ts.SyntaxKind.FalseKeyword ||
      ts.isStringLiteralLike(current) ||
      ts.isNumericLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
    ) {
      return undefined
    }
    return current
  }

  const unresolvedRenderBranch = collectReturnedExpressions(exportedWrapper)
    .map((expression) => inspectRenderExpression(expression, true))
    .find((expression): expression is ts.Expression => !!expression)
  if (unresolvedRenderBranch) {
    return [
      contractError(
        `EditableNumber 的返回路径包含未解析的 render helper 或 JSX 值（${unresolvedRenderBranch.getText(parsed.sourceFile)}），无法证明所有分支都解除 max 限制`
      )
    ]
  }

  const returnedOpenings = collectReturnedOpeningElements(exportedWrapper)
  const inputs = returnedOpenings.filter((opening) => {
    const resolution = resolver.resolveTag(opening.tagName)
    return resolution.kind === 'numeric' && resolution.reason.startsWith('import:InputNumber as ')
  })

  const hiddenMaxWrapper = returnedOpenings.find((opening) => resolver.wrapperMayContainMax(opening.tagName))
  if (hiddenMaxWrapper) {
    return [
      contractError(
        'EditableNumber 的返回路径包含可能隐藏 max 的本地包装组件，无法证明所有条件分支都解除限制',
        hiddenMaxWrapper
      )
    ]
  }

  if (inputs.length !== 1) {
    return [
      contractError(
        `${TRUSTED_EDITABLE_NUMBER_MODULE} 必须只包含一个来自 antd 的 InputNumber，当前发现 ${inputs.length} 个`
      )
    ]
  }

  const opening = inputs[0]
  const unsafeSibling = returnedOpenings.find(
    (candidate) =>
      candidate !== opening &&
      (resolver.resolveTag(candidate.tagName).kind === 'slider' ||
        attributeByName(candidate, 'max').length > 0 ||
        candidate.attributes.properties.some((property) => ts.isJsxSpreadAttribute(property)))
  )
  if (unsafeSibling) {
    return [
      contractError(
        'EditableNumber 的返回树包含额外 Slider、max 或 spread 分支，无法证明上下文输入不受隐藏限制',
        unsafeSibling
      )
    ]
  }

  const isTrustedStyledIntrinsic = (candidate: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean => {
    if (!ts.isIdentifier(candidate.tagName)) return false
    if (/^[a-z]/u.test(candidate.tagName.text)) return true
    if (bindings.isAmbiguous(candidate.tagName)) return false
    const binding = bindings.resolve(candidate.tagName)
    if (
      !binding ||
      !binding.readonly ||
      bindingHasWrite(binding, bindings) ||
      !ts.isVariableDeclaration(binding.declaration) ||
      !binding.declaration.initializer ||
      !ts.isTaggedTemplateExpression(binding.declaration.initializer)
    ) {
      return false
    }
    const styledTag = unwrapExpression(binding.declaration.initializer.tag)
    if (!ts.isPropertyAccessExpression(styledTag) || !/^[a-z][A-Za-z0-9]*$/u.test(styledTag.name.text)) return false
    const styled = unwrapExpression(styledTag.expression)
    if (!ts.isIdentifier(styled) || bindings.isAmbiguous(styled)) return false
    const styledBinding = bindings.resolve(styled)
    return (
      !!styledBinding &&
      !!importedModule(styledBinding.declaration) &&
      TRUSTED_STYLED_HOC_MODULES.has(importedModule(styledBinding.declaration)!)
    )
  }

  const opaqueSibling = returnedOpenings.find(
    (candidate) => candidate !== opening && !isTrustedStyledIntrinsic(candidate)
  )
  if (opaqueSibling) {
    return [
      contractError(
        `EditableNumber 的返回树包含无法证明安全的组件 ${jsxNameText(opaqueSibling.tagName)}，可能隐藏额外 max 限制`,
        opaqueSibling
      )
    ]
  }

  if (opening.attributes.properties.some((property) => ts.isJsxSpreadAttribute(property))) {
    return [contractError('EditableNumber 的 InputNumber 不能使用 spread，以免隐藏 max 覆盖', opening)]
  }

  const maxAttributes = attributeByName(opening, 'max')
  if (maxAttributes.length !== 1) {
    return [contractError('EditableNumber 必须把唯一的 max 属性直接透传给 InputNumber', opening)]
  }

  const maxExpression = attributeExpression(maxAttributes[0])
  if (!maxExpression || !ts.isIdentifier(maxExpression)) {
    return [contractError('EditableNumber 的 max 必须直接绑定到参数 max，不能使用默认值或计算表达式', opening)]
  }

  const maxBinding = bindings.resolve(maxExpression)
  const maxElement = maxBinding && bindingElementForIdentifier(maxBinding.identifier)
  if (
    !maxBinding ||
    !maxElement ||
    maxBinding.propertyName !== 'max' ||
    !ts.isParameter(maxBinding.declaration) ||
    !!maxElement.initializer
  ) {
    return [contractError('EditableNumber 的 max 不是无默认值的组件参数，拒绝信任跨文件实现', opening)]
  }

  let functionScope: ts.FunctionLikeDeclaration | undefined
  for (let current: ts.Node | undefined = opening; current; current = current.parent) {
    if (isFunctionScope(current)) {
      functionScope = current
      break
    }
  }
  if (functionScope !== maxBinding.scope) {
    return [contractError('EditableNumber 的 max 参数与 InputNumber 不在同一个函数作用域', opening)]
  }

  let unsafeReference = false
  const inspect = (node: ts.Node): void => {
    if (unsafeReference) return
    if (ts.isIdentifier(node) && bindings.resolve(node) === maxBinding && node !== maxBinding.identifier) {
      const parent = node.parent
      const allowed =
        node === maxExpression ||
        (ts.isJsxAttribute(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.name === node)
      if (!allowed) unsafeReference = true
    }
    ts.forEachChild(node, inspect)
  }
  inspect(parsed.sourceFile)
  if (unsafeReference) {
    return [contractError('EditableNumber 的 max 参数还被其他逻辑使用，无法证明移除调用点限制是安全的', opening)]
  }

  if (attributeByName(opening, 'parser').length > 0) {
    return [contractError('EditableNumber 的 InputNumber 不能声明 parser，以免在 max 之外隐藏输入限幅', opening)]
  }

  const parameterBindings = exportedWrapper.parameters[0]
    ? bindingIdentifiers(exportedWrapper.parameters[0].name)
        .map((identifier) => bindings.bindingOf(identifier))
        .filter((binding): binding is LexicalBinding => !!binding)
    : []
  const bindingsForProperty = (propertyName: string): LexicalBinding[] =>
    parameterBindings.filter((binding) => binding.propertyName === propertyName)
  const valueBindings = bindingsForProperty('value')
  const onChangeBindings = bindingsForProperty('onChange')
  const maxBindings = bindingsForProperty('max')
  const valueBinding = valueBindings.length === 1 ? valueBindings[0] : undefined
  const onChangeBinding = onChangeBindings.length === 1 ? onChangeBindings[0] : undefined
  const maxParameterBinding = maxBindings.length === 1 ? maxBindings[0] : undefined
  if (
    !maxParameterBinding ||
    maxParameterBinding !== maxBinding ||
    !isDirectParameterProperty(maxParameterBinding.identifier, 'max')
  ) {
    return [contractError('EditableNumber 的 max 必须直接来自唯一的无默认值组件参数', opening)]
  }
  if (!valueBinding || !isDirectParameterProperty(valueBinding.identifier, 'value')) {
    return [contractError('EditableNumber 必须直接声明无默认值的 value 参数')]
  }

  const mirrorCandidates = new Map<LexicalBinding, LexicalBinding>()
  const collectMirrorStates = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer)
      const [mirrorElement, setterElement] = node.name.elements
      const argument = ts.isCallExpression(initializer) ? initializer.arguments[0] : undefined
      const directArgument = argument && unwrapExpression(argument)
      if (
        node.name.elements.length === 2 &&
        ts.isCallExpression(initializer) &&
        initializer.arguments.length === 1 &&
        isTrustedReactCall(initializer.expression, 'useState', bindings) &&
        directArgument &&
        ts.isIdentifier(directArgument) &&
        bindings.resolve(directArgument) === valueBinding &&
        mirrorElement &&
        setterElement &&
        ts.isBindingElement(mirrorElement) &&
        ts.isBindingElement(setterElement) &&
        ts.isIdentifier(mirrorElement.name) &&
        ts.isIdentifier(setterElement.name) &&
        !mirrorElement.propertyName &&
        !setterElement.propertyName &&
        !mirrorElement.dotDotDotToken &&
        !setterElement.dotDotDotToken &&
        !mirrorElement.initializer &&
        !setterElement.initializer &&
        !ts.isOmittedExpression(mirrorElement) &&
        !ts.isOmittedExpression(setterElement)
      ) {
        const mirrorIdentifier = bindingIdentifiers(mirrorElement.name)[0]
        const setterIdentifier = bindingIdentifiers(setterElement.name)[0]
        const mirrorBinding = mirrorIdentifier && bindings.bindingOf(mirrorIdentifier)
        const setterBinding = setterIdentifier && bindings.bindingOf(setterIdentifier)
        if (mirrorBinding && setterBinding) {
          mirrorCandidates.set(setterBinding, mirrorBinding)
        }
      }
    }
    ts.forEachChild(node, collectMirrorStates)
  }
  if (exportedWrapper.body) collectMirrorStates(exportedWrapper.body)

  const valueAttributes = attributeByName(opening, 'value')
  if (valueAttributes.length !== 1) {
    return [contractError('EditableNumber 的 InputNumber value 必须只声明一次，避免重复属性隐藏实际绑定', opening)]
  }
  const inputValue = attributeExpression(valueAttributes[0])
  const directInputValue = inputValue && unwrapExpression(inputValue)
  const directInputBinding =
    directInputValue && ts.isIdentifier(directInputValue) ? bindings.resolve(directInputValue) : undefined
  const activeMirrorSetters = new Map<LexicalBinding, LexicalBinding>()
  if (directInputBinding) {
    for (const [setterBinding, mirrorBinding] of mirrorCandidates) {
      if (mirrorBinding === directInputBinding) activeMirrorSetters.set(setterBinding, mirrorBinding)
    }
  }
  if (
    !directInputValue ||
    !ts.isIdentifier(directInputValue) ||
    !directInputBinding ||
    (directInputBinding !== valueBinding && activeMirrorSetters.size === 0)
  ) {
    return [
      contractError('EditableNumber 的 InputNumber value 必须直接来自 value 参数或 useState(value) 镜像', opening)
    ]
  }

  const valueChannel = new Set<LexicalBinding>([valueBinding])
  if (directInputBinding !== valueBinding) valueChannel.add(directInputBinding)

  const hiddenLimit = exportedWrapper.body && containsHiddenUpperBound(exportedWrapper.body, valueChannel, bindings)
  if (hiddenLimit) {
    return [
      diagnosticAtNode(
        parsed.sourceFile,
        hiddenLimit,
        'TRUSTED_COMPONENT_CONTRACT',
        'EditableNumber 的 value 或内部镜像 state 存在条件、算术或限幅调用'
      )
    ]
  }

  for (const [setterBinding] of activeMirrorSetters) {
    let unsafeMirrorReference: ts.Node | undefined
    let rawValueWrites = 0
    const isRawValueWrite = (call: ts.CallExpression): boolean => {
      const callee = unwrapExpression(call.expression)
      const argument = call.arguments.length === 1 ? unwrapExpression(call.arguments[0]) : undefined
      return (
        ts.isIdentifier(callee) &&
        bindings.resolve(callee) === setterBinding &&
        !!argument &&
        ts.isIdentifier(argument) &&
        bindings.resolve(argument) === valueBinding
      )
    }

    const inspectMirrorSetter = (node: ts.Node): void => {
      if (unsafeMirrorReference) return
      if (ts.isIdentifier(node) && node !== setterBinding.identifier && bindings.resolve(node) === setterBinding) {
        const parent = node.parent
        if (ts.isCallExpression(parent) && parent.expression === node && isRawValueWrite(parent)) {
          rawValueWrites += 1
        } else {
          unsafeMirrorReference = node
          return
        }
      }
      ts.forEachChild(node, inspectMirrorSetter)
    }
    if (exportedWrapper.body) inspectMirrorSetter(exportedWrapper.body)
    if (unsafeMirrorReference) {
      return [
        diagnosticAtNode(
          parsed.sourceFile,
          unsafeMirrorReference,
          'TRUSTED_COMPONENT_CONTRACT',
          'EditableNumber 的内部镜像 state setter 只能原样写入 value 参数，不能被别名、传递或写入其他值'
        )
      ]
    }

    let hasValueSyncEffect = false
    const isDirectValueDependency = (expression: ts.Expression): boolean => {
      const current = unwrapExpression(expression)
      return ts.isIdentifier(current) && bindings.resolve(current) === valueBinding
    }
    const isTopLevelMirrorSync = (callback: ts.Expression): boolean => {
      const current = unwrapExpression(callback)
      const expression = ts.isArrowFunction(current) || ts.isFunctionExpression(current) ? current.body : undefined
      if (!expression) return false
      if (ts.isBlock(expression)) {
        if (expression.statements.length !== 1 || !ts.isExpressionStatement(expression.statements[0])) return false
        const statementExpression = unwrapExpression(expression.statements[0].expression)
        return ts.isCallExpression(statementExpression) && isRawValueWrite(statementExpression)
      }
      return ts.isCallExpression(expression) && isRawValueWrite(expression)
    }
    const isTopLevelHookCall = (call: ts.CallExpression): boolean => {
      const body = exportedWrapper.body
      if (!body || !ts.isBlock(body)) return false
      const statement = call.parent
      return ts.isExpressionStatement(statement) && statement.expression === call && statement.parent === body
    }
    const inspectSyncEffect = (node: ts.Node): void => {
      if (hasValueSyncEffect) return
      if (
        ts.isCallExpression(node) &&
        isTopLevelHookCall(node) &&
        (isTrustedReactCall(node.expression, 'useEffect', bindings) ||
          isTrustedReactCall(node.expression, 'useLayoutEffect', bindings))
      ) {
        const [callback, dependencies] = node.arguments
        if (
          callback &&
          !ts.isSpreadElement(callback) &&
          dependencies &&
          !ts.isSpreadElement(dependencies) &&
          ts.isArrayLiteralExpression(dependencies) &&
          !dependencies.elements.some((element) => ts.isSpreadElement(element)) &&
          dependencies.elements.some((element) => !ts.isSpreadElement(element) && isDirectValueDependency(element)) &&
          isTopLevelMirrorSync(callback)
        ) {
          hasValueSyncEffect = true
          return
        }
      }
      ts.forEachChild(node, inspectSyncEffect)
    }
    if (exportedWrapper.body) inspectSyncEffect(exportedWrapper.body)
    if (rawValueWrites === 0 || !hasValueSyncEffect) {
      return [
        contractError('EditableNumber 的 useState(value) 镜像必须通过依赖 value 的 effect 原样同步 setter', opening)
      ]
    }
  }

  const onChangeAttributes = attributeByName(opening, 'onChange')
  if (onChangeAttributes.length !== 1) {
    return [contractError('EditableNumber 的 InputNumber 必须声明唯一的 onChange 透明转发', opening)]
  }
  const componentOnChange = attributeExpression(onChangeAttributes[0])
  const handler = componentOnChange && localFunctionForExpression(componentOnChange, bindings)
  const handlerParameter = handler?.parameters[0]
  if (
    !componentOnChange ||
    !handler ||
    handler.parameters.length !== 1 ||
    !handlerParameter ||
    !ts.isIdentifier(handlerParameter.name) ||
    !!handlerParameter.initializer ||
    !!handlerParameter.questionToken ||
    !!handlerParameter.dotDotDotToken ||
    !onChangeBinding ||
    !isDirectParameterProperty(onChangeBinding.identifier, 'onChange')
  ) {
    return [contractError('EditableNumber 的 InputNumber onChange 必须是可解析的本地透明转发函数', opening)]
  }
  const handlerParameterBinding = bindings.bindingOf(handlerParameter.name)
  if (!handlerParameterBinding || bindingHasWrite(handlerParameterBinding, bindings)) {
    return [contractError('EditableNumber 的 onChange 回调参数必须保持原值且不可重赋', opening)]
  }
  const handlerTaint = new Set([handlerParameterBinding])
  const isForwardedValue = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression)
    if (ts.isIdentifier(current) && bindings.resolve(current) === handlerParameterBinding) return true
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const left = unwrapExpression(current.left)
      const right = unwrapExpression(current.right)
      return (
        ts.isIdentifier(left) &&
        bindings.resolve(left) === handlerParameterBinding &&
        right.kind === ts.SyntaxKind.NullKeyword
      )
    }
    return false
  }
  const unsafeTaintedFlow = unsafeTaintedUseBeforeTerminal(
    handler,
    handlerTaint,
    bindings,
    (call) => {
      const callee = unwrapExpression(call.expression)
      return (
        ts.isIdentifier(callee) &&
        bindings.resolve(callee) === onChangeBinding &&
        call.arguments.length === 1 &&
        isForwardedValue(call.arguments[0])
      )
    },
    () => false
  )
  if (unsafeTaintedFlow) {
    return [
      diagnosticAtNode(
        parsed.sourceFile,
        unsafeTaintedFlow,
        'TRUSTED_COMPONENT_CONTRACT',
        'EditableNumber 的 onChange 参数在原样转发前使用了不透明 helper、别名或异步控制流'
      )
    ]
  }
  const suspiciousHandler = handler.body && containsHiddenUpperBound(handler.body, handlerTaint, bindings)
  if (suspiciousHandler) {
    return [
      diagnosticAtNode(
        parsed.sourceFile,
        suspiciousHandler,
        'TRUSTED_COMPONENT_CONTRACT',
        'EditableNumber 的 onChange 对输入值执行了条件、算术或限幅调用'
      )
    ]
  }

  let forwardingCall: ts.CallExpression | undefined
  let unsafeOnChangeReference: ts.Node | undefined
  const inspectOnChangeReferences = (node: ts.Node): void => {
    if (unsafeOnChangeReference) return
    if (ts.isIdentifier(node) && node !== onChangeBinding.identifier && bindings.resolve(node) === onChangeBinding) {
      if (ts.isJsxAttribute(node.parent) && node.parent.name === node) return
      const parent = node.parent
      const callee = ts.isCallExpression(parent) ? unwrapExpression(parent.expression) : undefined
      if (
        ts.isCallExpression(parent) &&
        !!callee &&
        ts.isIdentifier(callee) &&
        bindings.resolve(callee) === onChangeBinding &&
        parent.arguments.length === 1 &&
        isForwardedValue(parent.arguments[0]) &&
        containingFunction(parent) === handler
      ) {
        if (forwardingCall) unsafeOnChangeReference = node
        else forwardingCall = parent
      } else unsafeOnChangeReference = node
      return
    }
    ts.forEachChild(node, inspectOnChangeReferences)
  }
  inspectOnChangeReferences(exportedWrapper)
  if (unsafeOnChangeReference || !forwardingCall) {
    return [
      contractError(
        'EditableNumber 的 onChange 参数只能在 InputNumber handler 中恰好一次原样转发回调值，不能被额外调用、传递或别名化',
        opening
      )
    ]
  }

  const directHandlerReference = unwrapExpression(componentOnChange)
  if (ts.isIdentifier(directHandlerReference)) {
    const handlerBinding = bindings.resolve(directHandlerReference)
    if (!handlerBinding) {
      return [contractError('EditableNumber 的 InputNumber onChange handler 绑定无法解析', opening)]
    }
    let unsafeHandlerReference: ts.Identifier | undefined
    const inspectHandlerReferences = (node: ts.Node): void => {
      if (unsafeHandlerReference) return
      if (
        ts.isIdentifier(node) &&
        node !== handlerBinding.identifier &&
        bindings.resolve(node) === handlerBinding &&
        node !== directHandlerReference
      ) {
        unsafeHandlerReference = node
        return
      }
      ts.forEachChild(node, inspectHandlerReferences)
    }
    inspectHandlerReferences(exportedWrapper)
    if (unsafeHandlerReference) {
      return [
        diagnosticAtNode(
          parsed.sourceFile,
          unsafeHandlerReference,
          'TRUSTED_COMPONENT_CONTRACT',
          'EditableNumber 的 InputNumber onChange handler 只能绑定到该输入组件，不能在 effect、其他回调或别名中再次调用'
        )
      ]
    }
  }

  return []
}

function validateContextGuardContract(filePath: string): ContextCountDiagnostic[] {
  const content = fs.readFileSync(filePath, 'utf8')
  const parsed = parseSource(content, filePath)
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return parsed.diagnostics
  const bindings = createBindingIndex(parsed.sourceFile)
  const declarations = parsed.sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'isValidContextCount' &&
      !!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  )
  if (declarations.length !== 1 || !declarations[0].body || declarations[0].parameters.length !== 1) {
    return [
      {
        severity: 'error',
        code: 'TRUSTED_GUARD_CONTRACT',
        message: 'isValidContextCount 必须是唯一导出的单参数函数声明'
      }
    ]
  }
  const declaration = declarations[0]
  const body = declaration.body
  const declarationBinding = declaration.name ? bindings.bindingOf(declaration.name) : undefined
  if (
    !declaration.name ||
    !declarationBinding ||
    bindingHasWrite(declarationBinding, bindings) ||
    !!declaration.asteriskToken ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return [
      {
        severity: 'error',
        code: 'TRUSTED_GUARD_CONTRACT',
        message: 'isValidContextCount 必须是不可重赋的普通同步函数声明'
      }
    ]
  }
  if (!body) {
    return [
      {
        severity: 'error',
        code: 'TRUSTED_GUARD_CONTRACT',
        message: 'isValidContextCount 函数体不可缺失'
      }
    ]
  }
  const parameter = declaration.parameters[0]
  if (
    !ts.isIdentifier(parameter.name) ||
    !!parameter.initializer ||
    !!parameter.questionToken ||
    !!parameter.dotDotDotToken
  ) {
    return [
      {
        severity: 'error',
        code: 'TRUSTED_GUARD_CONTRACT',
        message: 'isValidContextCount 参数必须是简单标识符'
      }
    ]
  }
  const parameterBinding = bindings.bindingOf(parameter.name)
  if (!parameterBinding || bindingHasWrite(parameterBinding, bindings)) {
    return [
      {
        severity: 'error',
        code: 'TRUSTED_GUARD_CONTRACT',
        message: 'isValidContextCount 参数不可重赋或变异'
      }
    ]
  }
  const returns = body.statements.filter(
    (statement): statement is ts.ReturnStatement => ts.isReturnStatement(statement) && !!statement.expression
  )
  if (returns.length !== 1 || body.statements.length !== 1 || !returns[0].expression) {
    return [
      {
        severity: 'error',
        code: 'TRUSTED_GUARD_CONTRACT',
        message: 'isValidContextCount 必须直接返回可静态验证的无上界谓词'
      }
    ]
  }

  const terms: ts.Expression[] = []
  const flattenAnd = (expression: ts.Expression): void => {
    const current = unwrapExpression(expression)
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      flattenAnd(current.left)
      flattenAnd(current.right)
    } else terms.push(current)
  }
  flattenAnd(returns[0].expression)

  const isParameterIdentifier = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression)
    return ts.isIdentifier(current) && bindings.resolve(current) === parameterBinding
  }
  const isZero = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression)
    return ts.isNumericLiteral(current) && Number(current.text) === 0
  }
  const isTypeCheck = (expression: ts.Expression): boolean => {
    if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
      return false
    const left = unwrapExpression(expression.left)
    const right = unwrapExpression(expression.right)
    return (
      (ts.isTypeOfExpression(left) &&
        isParameterIdentifier(left.expression) &&
        ts.isStringLiteral(right) &&
        right.text === 'number') ||
      (ts.isTypeOfExpression(right) &&
        isParameterIdentifier(right.expression) &&
        ts.isStringLiteral(left) &&
        left.text === 'number')
    )
  }
  const isSafeIntegerCheck = (expression: ts.Expression): boolean => {
    if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) return false
    const callee = unwrapExpression(expression.expression)
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'isSafeInteger') return false
    const numberObject = unwrapExpression(callee.expression)
    return (
      ts.isIdentifier(numberObject) &&
      numberObject.text === 'Number' &&
      !bindings.resolve(numberObject) &&
      isParameterIdentifier(expression.arguments[0])
    )
  }
  const isNonNegativeCheck = (expression: ts.Expression): boolean => {
    if (!ts.isBinaryExpression(expression)) return false
    return (
      (expression.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken &&
        isParameterIdentifier(expression.left) &&
        isZero(expression.right)) ||
      (expression.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken &&
        isZero(expression.left) &&
        isParameterIdentifier(expression.right))
    )
  }

  if (
    terms.length !== 3 ||
    !terms.some(isTypeCheck) ||
    !terms.some(isSafeIntegerCheck) ||
    !terms.some(isNonNegativeCheck) ||
    terms.some((term) => !isTypeCheck(term) && !isSafeIntegerCheck(term) && !isNonNegativeCheck(term))
  ) {
    return [
      {
        severity: 'error',
        code: 'TRUSTED_GUARD_CONTRACT',
        message:
          'isValidContextCount 只能验证 number、Number.isSafeInteger(value) 与 value >= 0，不能包含有限上界或不透明 helper'
      }
    ]
  }
  return []
}

function listSourceFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) visit(path.join(directory, entry.name))
      else if (
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

export interface CliOptions {
  root: string
  write: boolean
  requireTargets: boolean
  expectedTargets?: number
  expectedSliders?: number
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = { root: process.cwd(), write: false, requireTargets: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--write') options.write = true
    else if (arg === '--require-targets') options.requireTargets = true
    else if (arg === '--expected-targets') {
      const expectedTargets = Number(argv[++index])
      if (!Number.isSafeInteger(expectedTargets) || expectedTargets < 1)
        throw new Error('--expected-targets 必须是正整数')
      options.expectedTargets = expectedTargets
    } else if (arg === '--expected-sliders') {
      const expectedSliders = Number(argv[++index])
      if (!Number.isSafeInteger(expectedSliders) || expectedSliders < 0)
        throw new Error('--expected-sliders 必须是非负整数')
      options.expectedSliders = expectedSliders
    } else if (arg === '--root') options.root = path.resolve(argv[++index] ?? '')
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法: node --experimental-strip-types scripts/context-count-patch.ts [--root DIR] [--write] [--require-targets] [--expected-targets N] [--expected-sliders N]'
      )
      process.exit(0)
    } else throw new Error(`未知参数: ${arg}`)
  }
  return options
}

export interface ContextCountRunResult {
  files: number
  candidates: number
  changed: number
  ignoredSliders: number
  diagnostics: ContextCountDiagnostic[]
}

export interface ContextCountWriteOperations {
  writeFileSync(filePath: string, content: string, encoding: BufferEncoding): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(filePath: string): void
  existsSync(filePath: string): boolean
}

let transactionSequence = 0

function writeTransaction(
  pendingWrites: Array<{ filePath: string; content: string }>,
  overrides: Partial<ContextCountWriteOperations> = {}
): void {
  if (pendingWrites.length === 0) return
  const operations: ContextCountWriteOperations = {
    writeFileSync: (filePath, content, encoding) => fs.writeFileSync(filePath, content, encoding),
    renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
    unlinkSync: (filePath) => fs.unlinkSync(filePath),
    existsSync: (filePath) => fs.existsSync(filePath),
    ...overrides
  }
  const token = `${process.pid}-${Date.now()}-${transactionSequence++}`
  const entries = pendingWrites.map((pending, index) => ({
    ...pending,
    temporaryPath: `${pending.filePath}.context-count-patch-${token}-${index}.tmp`,
    backupPath: `${pending.filePath}.context-count-patch-${token}-${index}.bak`,
    backedUp: false,
    installed: false
  }))

  const removeIfPresent = (filePath: string): void => {
    if (operations.existsSync(filePath)) operations.unlinkSync(filePath)
  }

  try {
    for (const entry of entries) {
      if (operations.existsSync(entry.temporaryPath) || operations.existsSync(entry.backupPath)) {
        throw new Error(`事务临时路径已存在: ${entry.temporaryPath}`)
      }
      operations.writeFileSync(entry.temporaryPath, entry.content, 'utf8')
    }

    for (const entry of entries) {
      operations.renameSync(entry.filePath, entry.backupPath)
      entry.backedUp = true
      operations.renameSync(entry.temporaryPath, entry.filePath)
      entry.installed = true
    }
  } catch (error) {
    const rollbackErrors: string[] = []
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.installed) removeIfPresent(entry.filePath)
        if (entry.backedUp && operations.existsSync(entry.backupPath)) {
          operations.renameSync(entry.backupPath, entry.filePath)
          entry.backedUp = false
        }
        removeIfPresent(entry.temporaryPath)
      } catch (rollbackError) {
        rollbackErrors.push(
          `${entry.filePath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        )
      }
    }
    const reason = error instanceof Error ? error.message : String(error)
    const rollbackStatus = rollbackErrors.length === 0 ? '已完整回滚' : `回滚异常：${rollbackErrors.join('; ')}`
    throw new Error(`上下文补丁写入事务失败（${rollbackStatus}）：${reason}`)
  }

  const cleanupErrors: string[] = []
  for (const entry of entries) {
    try {
      removeIfPresent(entry.backupPath)
    } catch (error) {
      cleanupErrors.push(`${entry.backupPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (cleanupErrors.length > 0) {
    console.warn(`上下文补丁已完成写入，但备份清理失败（保留备份供恢复）：${cleanupErrors.join('; ')}`)
  }
}

function throwContract(message: string): never {
  throw new Error(`上下文补丁契约失败：${message}`)
}

export function run(
  options: CliOptions,
  writeOperations: Partial<ContextCountWriteOperations> = {}
): ContextCountRunResult {
  if (!fs.existsSync(options.root) || !fs.statSync(options.root).isDirectory())
    throw new Error(`目录不存在: ${options.root}`)

  let fileCount = 0
  let candidateCount = 0
  let changedCount = 0
  let ignoredSliderCount = 0
  const diagnostics: ContextCountDiagnostic[] = []
  const pendingWrites: Array<{ filePath: string; content: string }> = []
  const allCandidates: Array<ContextCountCandidate & { filePath: string }> = []
  const allSliders: Array<ContextCountIgnoredSlider & { filePath: string }> = []
  const sourceFiles = listSourceFiles(options.root)
  const editableResolution = resolveTrustedSourceModule(
    options.root,
    sourceFiles,
    TRUSTED_EDITABLE_NUMBER_MODULE,
    TRUSTED_EDITABLE_NUMBER_PATH,
    (clause) => !!clause.name
  )
  diagnostics.push(...editableResolution.diagnostics)
  let editableContractTrusted = false
  if (editableResolution.filePath) {
    const contractDiagnostics = validateEditableNumberContract(editableResolution.filePath)
    editableContractTrusted = contractDiagnostics.length === 0
    diagnostics.push(
      ...contractDiagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: `${TRUSTED_EDITABLE_NUMBER_PATH}: ${diagnostic.message}`
      }))
    )
  }

  const guardResolution = resolveTrustedSourceModule(
    options.root,
    sourceFiles,
    TRUSTED_CONTEXT_GUARD_MODULE,
    TRUSTED_CONTEXT_GUARD_PATH,
    (clause) =>
      !!clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.some((element) => importedName(element) === 'isValidContextCount')
  )
  diagnostics.push(...guardResolution.diagnostics)
  let guardContractTrusted = false
  if (guardResolution.filePath) {
    const guardDiagnostics = validateContextGuardContract(guardResolution.filePath)
    guardContractTrusted = guardDiagnostics.length === 0
    diagnostics.push(
      ...guardDiagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: `${TRUSTED_CONTEXT_GUARD_PATH}: ${diagnostic.message}`
      }))
    )
  }

  for (const filePath of sourceFiles) {
    const original = fs.readFileSync(filePath, 'utf8')
    const fileIdentity = pathIdentity(path.resolve(filePath))
    const trustedDefaultModules = new Set<string>()
    if (editableContractTrusted && editableResolution.importers.has(fileIdentity)) {
      trustedDefaultModules.add(TRUSTED_EDITABLE_NUMBER_MODULE)
    }
    const trustedContextGuardModules = new Set<string>()
    if (guardContractTrusted && guardResolution.importers.has(fileIdentity)) {
      trustedContextGuardModules.add(TRUSTED_CONTEXT_GUARD_MODULE)
    }
    const result = patchContextCountSource(original, filePath, {
      trustedDefaultModules,
      trustedContextGuardModules,
      requireNumericOnChange:
        options.expectedTargets !== undefined &&
        options.expectedTargets > 0 &&
        options.expectedTargets === options.expectedSliders,
      requireSliderValueState:
        options.expectedTargets !== undefined &&
        options.expectedTargets > 0 &&
        options.expectedTargets === options.expectedSliders
    })
    if (result.candidates.length === 0 && result.ignoredSliders.length === 0 && result.diagnostics.length === 0)
      continue

    fileCount += 1
    candidateCount += result.candidates.length
    changedCount += result.changed
    ignoredSliderCount += result.ignoredSliders.length
    allCandidates.push(...result.candidates.map((candidate) => ({ ...candidate, filePath })))
    allSliders.push(...result.ignoredSliders.map((slider) => ({ ...slider, filePath })))
    diagnostics.push(
      ...result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: `${path.relative(options.root, filePath)}: ${diagnostic.message}`
      }))
    )

    for (const candidate of result.candidates) {
      const state = candidate.hasMax ? `${candidate.maxCount} 个显式 max` : '无显式 max'
      console.log(
        `${options.write ? '候选' : '发现'} ${path.relative(options.root, filePath)}:${candidate.line}:${candidate.column} <${candidate.component}> value={${candidate.valueExpression}} ${state} [${candidate.resolution}]`
      )
    }
    for (const slider of result.ignoredSliders) {
      console.log(
        `保护 ${path.relative(options.root, filePath)}:${slider.line}:${slider.column} <${slider.component}> Slider 保持不变（${slider.hasMax ? '保留 max' : '无 max'}） [${slider.reason}]`
      )
    }
    if (options.write && result.content !== original) pendingWrites.push({ filePath, content: result.content })
  }

  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  if (errors.length > 0) throwContract(errors.map(formatDiagnostic).join('\n'))
  if (options.requireTargets && candidateCount === 0) throwContract('未找到可确认的上下文数字输入组件，可能上游已重构')
  if (options.expectedTargets !== undefined && candidateCount !== options.expectedTargets) {
    throwContract(`上下文输入组件数量异常：期望 ${options.expectedTargets} 个，实际 ${candidateCount} 个`)
  }
  if (options.expectedSliders !== undefined && ignoredSliderCount !== options.expectedSliders) {
    throwContract(`受保护 Slider 数量异常：期望 ${options.expectedSliders} 个，实际 ${ignoredSliderCount} 个`)
  }
  if (
    options.expectedTargets !== undefined &&
    options.expectedSliders !== undefined &&
    options.expectedTargets > 0 &&
    options.expectedTargets === options.expectedSliders
  ) {
    const unboundCandidates = allCandidates.filter((candidate) => !candidate.stateKey)
    const unboundSliders = allSliders.filter((slider) => !slider.stateKey)
    if (unboundCandidates.length > 0 || unboundSliders.length > 0) {
      throwContract('存在无法关联到唯一 canonical contextCount state 的数字输入或 Slider')
    }
    const groups = new Map<
      string,
      {
        candidates: typeof allCandidates
        sliders: typeof allSliders
      }
    >()
    for (const candidate of allCandidates) {
      const group = groups.get(candidate.stateKey!) ?? { candidates: [], sliders: [] }
      group.candidates.push(candidate)
      groups.set(candidate.stateKey!, group)
    }
    for (const slider of allSliders) {
      const group = groups.get(slider.stateKey!) ?? { candidates: [], sliders: [] }
      group.sliders.push(slider)
      groups.set(slider.stateKey!, group)
    }
    const malformed = [...groups.values()].filter(
      (group) => group.candidates.length !== 1 || group.sliders.length !== 1 || !group.candidates[0]?.hasOnChange
    )
    const pages = new Set(
      [...groups.values()].flatMap((group) => group.candidates.map((candidate) => pathIdentity(candidate.filePath)))
    )
    if (groups.size !== options.expectedTargets || malformed.length > 0 || pages.size !== options.expectedTargets) {
      const summary = [...groups.values()]
        .map((group) => {
          const location = group.candidates[0]?.filePath ?? group.sliders[0]?.filePath ?? '<unknown>'
          return `${path.relative(options.root, location)}: ${group.candidates.length} input / ${group.sliders.length} Slider`
        })
        .join('; ')
      throwContract(
        `canonical state 配对异常：期望 ${options.expectedTargets} 个独立页面各 1 input + 1 Slider，实际 ${groups.size} 个 state、${pages.size} 个页面${summary ? `（${summary}）` : ''}`
      )
    }
  }
  if (!options.write && changedCount > 0) throwContract(`仍有 ${changedCount} 处上下文数字输入框存在 max 限制`)

  writeTransaction(pendingWrites, writeOperations)
  return {
    files: fileCount,
    candidates: candidateCount,
    changed: changedCount,
    ignoredSliders: ignoredSliderCount,
    diagnostics
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = run(parseOptions(process.argv.slice(2)))
    console.log(
      `上下文输入检查完成：${result.files} 个文件，${result.candidates} 个目标组件，保护 ${result.ignoredSliders} 个 Slider`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
