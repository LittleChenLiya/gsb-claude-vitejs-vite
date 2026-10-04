import debug from 'obug'

/**
 * Config hook attribution diagnostics.
 *
 * When enabled (via the `vite:config-attribution` debug namespace, e.g.
 * `DEBUG=vite:config-attribution`), Vite takes an immutable snapshot of the
 * config before and after every `config` hook and reports which plugin
 * introduced, removed or replaced each config leaf value.
 *
 * The diagnostics never re-run hooks and never execute non-serializable
 * values (functions, RegExp, class instances, ...). Those are represented by
 * an explicit identity digest instead.
 */

const attributionLog = debug('vite:config-attribution')

/**
 * Programmatically toggle config hook attribution. The mode is normally
 * selected through the `DEBUG` environment variable; this hook exists for
 * tests and tooling that want to force-enable the diagnostics.
 */
export function setConfigAttributionEnabled(enabled: boolean): void {
  attributionLog.enabled = enabled
}

export function isConfigAttributionEnabled(): boolean {
  return attributionLog.enabled
}

// ---------------------------------------------------------------------------
// Immutable config snapshot
// ---------------------------------------------------------------------------

const NODE: unique symbol = Symbol('vite.configAttribution.node')

interface SnapshotObject {
  readonly [NODE]: 'object'
  readonly entries: ReadonlyArray<readonly [string, Snapshot]>
}
interface SnapshotArray {
  readonly [NODE]: 'array'
  readonly items: ReadonlyArray<Snapshot>
}
interface SnapshotValue {
  readonly [NODE]: 'value'
  readonly value: unknown
}
interface SnapshotRef {
  readonly [NODE]: 'ref'
  readonly id: number
  readonly kind: string
  readonly label: string
}

type Snapshot = SnapshotObject | SnapshotArray | SnapshotValue | SnapshotRef

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto == null
}

function describeKind(value: object): string {
  if (value instanceof RegExp) return 'RegExp'
  if (typeof value === 'function') return 'Function'
  if (value instanceof Date) return 'Date'
  if (value instanceof Map) return 'Map'
  if (value instanceof Set) return 'Set'
  return value.constructor?.name || 'Object'
}

function describeLabel(value: object, id: number): string {
  const kind = describeKind(value)
  let hint = ''
  if (typeof value === 'function') {
    const name = (value as Function).name
    if (name) hint = `:${name}`
  } else if (value instanceof RegExp) {
    hint = `:${value.source}`
  }
  return `[${kind}#${id}${hint}]`
}

/**
 * Builds immutable deep snapshots of config values. Non-plain objects
 * (functions, RegExp, class instances, ...) are never traversed or executed;
 * they are represented by an explicit identity digest that is stable across
 * snapshots taken by the same builder.
 */
class SnapshotBuilder {
  private readonly refs = new WeakMap<object, number>()
  private nextRefId = 1

  build(value: unknown): Snapshot {
    if (value == null) {
      return { [NODE]: 'value', value }
    }
    if (typeof value === 'function') {
      return this.buildRef(value)
    }
    if (typeof value !== 'object') {
      return { [NODE]: 'value', value }
    }
    if (Array.isArray(value)) {
      return {
        [NODE]: 'array',
        items: value.map((item) => this.build(item)),
      }
    }
    if (isPlainObject(value)) {
      return {
        [NODE]: 'object',
        entries: Object.keys(value).map((key) => [
          key,
          this.build((value as Record<string, unknown>)[key]),
        ]),
      }
    }
    return this.buildRef(value)
  }

  private buildRef(value: object): SnapshotRef {
    let id = this.refs.get(value)
    if (id === undefined) {
      id = this.nextRefId++
      this.refs.set(value, id)
    }
    return {
      [NODE]: 'ref',
      id,
      kind: describeKind(value),
      label: describeLabel(value, id),
    }
  }
}

function snapshotEqual(a: Snapshot, b: Snapshot): boolean {
  if (a[NODE] !== b[NODE]) return false
  switch (a[NODE]) {
    case 'value':
      return Object.is(a.value, (b as SnapshotValue).value)
    case 'ref':
      return a.id === (b as SnapshotRef).id
    case 'array': {
      const ba = b as SnapshotArray
      return (
        a.items.length === ba.items.length &&
        a.items.every((item, i) => snapshotEqual(item, ba.items[i]))
      )
    }
    case 'object': {
      const bo = b as SnapshotObject
      if (a.entries.length !== bo.entries.length) return false
      const bMap = new Map(bo.entries)
      return a.entries.every(([key, node]) => {
        const other = bMap.get(key)
        return other !== undefined && snapshotEqual(node, other)
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface AttributionChange {
  op: 'add' | 'delete' | 'replace'
  path: string[]
  before?: Snapshot
  after?: Snapshot
}

/**
 * Yields an `add` entry for every leaf contained in `node`, so that adding a
 * whole subtree (e.g. `server: { port: 3000 }`) is reported at leaf paths
 * (`server.port`) rather than as a single opaque subtree addition.
 */
function addedLeaves(node: Snapshot, path: string[]): AttributionChange[] {
  if (node[NODE] === 'object') {
    const changes: AttributionChange[] = []
    for (const [key, child] of node.entries) {
      changes.push(...addedLeaves(child, [...path, key]))
    }
    return changes
  }
  if (node[NODE] === 'array') {
    const changes: AttributionChange[] = []
    for (let i = 0; i < node.items.length; i++) {
      changes.push(...addedLeaves(node.items[i], [...path, String(i)]))
    }
    return changes
  }
  return [{ op: 'add', path, after: node }]
}

/**
 * Yields a `delete` entry for every leaf contained in `node`.
 */
function deletedLeaves(node: Snapshot, path: string[]): AttributionChange[] {
  if (node[NODE] === 'object') {
    const changes: AttributionChange[] = []
    for (const [key, child] of node.entries) {
      changes.push(...deletedLeaves(child, [...path, key]))
    }
    return changes
  }
  if (node[NODE] === 'array') {
    const changes: AttributionChange[] = []
    for (let i = 0; i < node.items.length; i++) {
      changes.push(...deletedLeaves(node.items[i], [...path, String(i)]))
    }
    return changes
  }
  return [{ op: 'delete', path, before: node }]
}

function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
  path: string[] = [],
): AttributionChange[] {
  const changes: AttributionChange[] = []

  if (before[NODE] === 'object' && after[NODE] === 'object') {
    const beforeMap = new Map(before.entries)
    for (const [key, afterNode] of after.entries) {
      const beforeNode = beforeMap.get(key)
      const childPath = [...path, key]
      if (beforeNode === undefined) {
        changes.push(...addedLeaves(afterNode, childPath))
      } else if (!snapshotEqual(beforeNode, afterNode)) {
        changes.push(...diffSnapshots(beforeNode, afterNode, childPath))
      }
    }
    for (const [key, beforeNode] of before.entries) {
      if (!after.entries.some(([k]) => k === key)) {
        changes.push(...deletedLeaves(beforeNode, [...path, key]))
      }
    }
    return changes
  }

  if (before[NODE] === 'array' && after[NODE] === 'array') {
    const max = Math.max(before.items.length, after.items.length)
    for (let i = 0; i < max; i++) {
      const childPath = [...path, String(i)]
      if (i >= before.items.length) {
        changes.push(...addedLeaves(after.items[i], childPath))
      } else if (i >= after.items.length) {
        changes.push(...deletedLeaves(before.items[i], childPath))
      } else if (!snapshotEqual(before.items[i], after.items[i])) {
        changes.push(
          ...diffSnapshots(before.items[i], after.items[i], childPath),
        )
      }
    }
    return changes
  }

  if (!snapshotEqual(before, after)) {
    changes.push({ op: 'replace', path, before, after })
  }
  return changes
}

// ---------------------------------------------------------------------------
// Sensitive path masking
// ---------------------------------------------------------------------------

const SENSITIVE_PATH_RE =
  /(?:password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key|client[_-]?secret)$/i

function isSensitivePath(path: string[]): boolean {
  const leaf = path.at(-1)
  return leaf !== undefined && SENSITIVE_PATH_RE.test(leaf)
}

// ---------------------------------------------------------------------------
// Snapshot serialization for reports
// ---------------------------------------------------------------------------

function formatPrimitive(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') {
    return `[Function: ${(value as Function).name || 'anonymous'}]`
  }
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return String(value)
  }
}

function serializeSnapshot(node: Snapshot, path: string[] = []): string {
  switch (node[NODE]) {
    case 'value':
      return formatPrimitive(node.value)
    case 'ref':
      return node.label
    case 'array': {
      const items = node.items.map((item, i) =>
        serializeSnapshot(item, [...path, String(i)]),
      )
      return `[${items.join(', ')}]`
    }
    case 'object': {
      const parts = node.entries.map(([key, child]) => {
        const childPath = [...path, key]
        const value = isSensitivePath(childPath)
          ? '***'
          : serializeSnapshot(child, childPath)
        return `${key}: ${value}`
      })
      return `{ ${parts.join(', ')} }`
    }
  }
}

function formatPath(path: string[]): string {
  return path.reduce((acc, segment, i) => {
    if (i === 0) return segment
    if (/^\d+$/.test(segment)) return `${acc}[${segment}]`
    return `${acc}.${segment}`
  }, '')
}

function formatChange(change: AttributionChange): string {
  const path = formatPath(change.path)
  const masked = isSensitivePath(change.path)
  switch (change.op) {
    case 'add':
      return `+ ${path}: ${
        masked ? '***' : serializeSnapshot(change.after!, change.path)
      }`
    case 'delete':
      return `- ${path}: ${
        masked ? '***' : serializeSnapshot(change.before!, change.path)
      }`
    case 'replace':
      return `~ ${path}: ${
        masked
          ? '***'
          : `${serializeSnapshot(change.before!, change.path)} => ${serializeSnapshot(change.after!, change.path)}`
      }`
  }
}

// ---------------------------------------------------------------------------
// Attribution session
// ---------------------------------------------------------------------------

export interface ConfigAttributionRecord {
  plugin: string
  changes: AttributionChange[]
  failed?: boolean
  error?: string
}

/**
 * Collects config hook attribution records for one `resolveConfig` call.
 *
 * The session is purely observational: snapshots are immutable copies of the
 * config, diffs are computed from those copies and non-serializable values
 * are only represented by identity digests. Hooks are never re-run.
 */
export class ConfigAttributionSession {
  private readonly builder = new SnapshotBuilder()
  private readonly records: ConfigAttributionRecord[] = []
  private flushed = false

  snapshot(value: unknown): Snapshot {
    return this.builder.build(value)
  }

  record(plugin: string, before: Snapshot, after: Snapshot): void {
    this.records.push({
      plugin,
      changes: diffSnapshots(before, after),
    })
  }

  recordFailure(plugin: string, error: unknown): void {
    this.records.push({
      plugin,
      changes: [],
      failed: true,
      error: error instanceof Error ? error.message : String(error),
    })
    this.flush()
  }

  /**
   * Renders the attribution report. Exposed for tests and tooling; the
   * diagnostic output goes through the `vite:config-attribution` logger.
   */
  render(): string[] {
    const lines: string[] = []
    lines.push(
      `Config hook attribution report (${this.records.length} hook(s) observed)`,
    )
    for (const record of this.records) {
      if (record.failed) {
        lines.push(`  plugin "${record.plugin}" FAILED: ${record.error}`)
        lines.push(
          `  (attribution records completed before the failure are listed above)`,
        )
        continue
      }
      if (record.changes.length === 0) {
        lines.push(`  plugin "${record.plugin}": no config changes`)
        continue
      }
      lines.push(`  plugin "${record.plugin}":`)
      for (const change of record.changes) {
        lines.push(`    ${formatChange(change)}`)
      }
    }
    lines.push(`End of config hook attribution report`)
    return lines
  }

  flush(): void {
    if (this.flushed) return
    this.flushed = true
    for (const line of this.render()) {
      attributionLog(line)
    }
  }
}
