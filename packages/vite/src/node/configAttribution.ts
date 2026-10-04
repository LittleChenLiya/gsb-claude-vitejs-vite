import nodeCrypto from 'node:crypto'
import type { InlineConfig } from './config'

/**
 * Optional, opt-in diagnostic that records which plugin `config` hook is
 * responsible for the final value of selected config paths.
 *
 * Enabled per `resolveConfig` run via {@link ConfigAttributionOptions}. The
 * diagnostic never re-runs any hook: snapshots are taken before and after
 * each hook during the normal hook execution.
 */

/** Kind of a single attributed change. */
export type ConfigAttributionChangeKind = 'set' | 'replace' | 'delete'

/** A single change attributed to one plugin `config` hook. */
export interface ConfigAttributionChange {
  /** Dot-separated config path, e.g. `server.port` or `resolve.alias`. */
  path: string
  /**
   * - `set`: the path did not exist before the hook and exists afterwards
   *   (including a previously deleted path being re-added)
   * - `replace`: the path existed both before and after the hook with a
   *   different value (in-place mutations are detected)
   * - `delete`: the path existed before the hook and is gone afterwards
   */
  kind: ConfigAttributionChangeKind
  /** Name of the plugin whose `config` hook caused the change. */
  plugin: string
  /** 1-based order in which the plugin hook ran. */
  order: number
  /** Stable, non-executable summary of the value before the hook. */
  before?: ConfigValueSummary
  /** Stable, non-executable summary of the value after the hook. */
  after?: ConfigValueSummary
}

/**
 * Stable, non-executable representation of a config value. Plain JSON-able
 * values are captured literally; values that cannot be serialized stably
 * (functions, RegExp, symbols, ...) are only represented by an explicit
 * identity digest. They are never invoked, and RegExp patterns are never
 * printed.
 */
export interface ConfigValueSummary {
  type:
    | 'undefined'
    | 'null'
    | 'string'
    | 'number'
    | 'boolean'
    | 'bigint'
    | 'array'
    | 'object'
    | 'function'
    | 'regexp'
    | 'symbol'
    | 'unknown'
  /** Present for stable JSON-able values (`string`/`number`/`boolean`). */
  value?: string | number | boolean
  /** Present for `array`/`object` values; entries are redacted when needed. */
  valueJson?: unknown
  /** Identity digest for values without a stable serialization. */
  digest?: string
  /** Function or constructor name, for debugging only. */
  name?: string
  /** Set to true when the literal value was redacted for a sensitive path. */
  redacted?: boolean
}

/** Record for one executed plugin `config` hook. */
export interface ConfigAttributionHookRecord {
  /** Name of the plugin. */
  plugin: string
  /** 1-based execution order. */
  order: number
  /** Changes on watched paths caused by this hook. */
  changes: ConfigAttributionChange[]
  /**
   * Error thrown by the hook, if it failed. Attribution records produced by
   * hooks that completed before the failure are preserved.
   */
  error?: {
    name: string
    message: string
  }
}

/** Result of a config attribution diagnostic run. */
export interface ConfigAttributionReport {
  /** Watched config paths. */
  paths: string[]
  /** One record per executed plugin `config` hook, in execution order. */
  hooks: ConfigAttributionHookRecord[]
  /**
   * Final attribution per watched path: the last hook record that changed
   * it. A watched path is absent when no hook changed it.
   */
  final: Record<string, ConfigAttributionChange>
  /** The hook that failed, if any. */
  failedHook?: {
    plugin: string
    order: number
    error: {
      name: string
      message: string
    }
  }
}

export interface ConfigAttributionOptions {
  /**
   * Config paths to watch, dot-separated (e.g. `['server.port']`). When
   * omitted a small default set of commonly overridden paths is used.
   */
  paths?: string[]
  /**
   * Sensitive paths whose literal values must never appear in the report
   * (matched by exact path or any path below the prefix). Identity digests
   * are still reported, so changes remain attributable.
   *
   * @default ['env', 'server.proxy']
   */
  redactedPaths?: string[]
  /** Called whenever a hook completes with the accumulated report so far. */
  onRecord?: (report: ConfigAttributionReport) => void
}

interface InternalOptions {
  paths: string[]
  redactedPaths: string[]
  onRecord?: (report: ConfigAttributionReport) => void
}

const DEFAULT_PATHS = [
  'server.port',
  'server.host',
  'resolve.alias',
  'base',
  'publicDir',
]

const DEFAULT_REDACTED_PATHS = ['env', 'server.proxy']

/**
 * Create a config attribution tracker for one `runConfigHook` pass.
 * @internal
 */
export function createConfigAttributionTracker(
  options: ConfigAttributionOptions | boolean | undefined,
): ConfigAttributionTracker | null {
  if (!options) return null
  const resolved: InternalOptions = {
    paths:
      options === true || options.paths === undefined
        ? [...DEFAULT_PATHS]
        : [...options.paths],
    redactedPaths:
      options === true || options.redactedPaths === undefined
        ? [...DEFAULT_REDACTED_PATHS]
        : [...options.redactedPaths],
    onRecord: options === true ? undefined : options.onRecord,
  }
  if (resolved.paths.length === 0) return null
  return new ConfigAttributionTracker(resolved)
}

/**
 * Stateful tracker that snapshots watched config paths around each plugin
 * `config` hook. Snapshots are immutable plain summaries; they never alias
 * live config objects, so later in-place mutations cannot rewrite history.
 * @internal
 */
export class ConfigAttributionTracker {
  private readonly paths: string[]
  private readonly redactedPaths: string[]
  private readonly onRecord?: (report: ConfigAttributionReport) => void
  private readonly hookRecords: ConfigAttributionHookRecord[] = []
  private failedHook: ConfigAttributionReport['failedHook'] | undefined
  private order = 0

  constructor(options: InternalOptions) {
    this.paths = options.paths
    this.redactedPaths = options.redactedPaths
    this.onRecord = options.onRecord
  }

  /** Immutable snapshot of the watched paths of `config` before a hook runs. */
  snapshot(config: InlineConfig): Readonly<Record<string, ConfigValueSummary>> {
    const snap: Record<string, ConfigValueSummary> = {}
    for (const p of this.paths) {
      snap[p] = this.summarizePath(config, p)
    }
    return Object.freeze(snap)
  }

  /** Record one executed hook by diffing the immutable before/after snapshots. */
  recordHook(
    plugin: string,
    before: Readonly<Record<string, ConfigValueSummary>>,
    after: Readonly<Record<string, ConfigValueSummary>>,
  ): ConfigAttributionHookRecord {
    this.order++
    const record: ConfigAttributionHookRecord = {
      plugin,
      order: this.order,
      changes: [],
    }
    for (const p of this.paths) {
      const change = diffSummaries(p, plugin, this.order, before[p], after[p])
      if (change) record.changes.push(change)
    }
    this.hookRecords.push(record)
    this.onRecord?.(this.getReport())
    return record
  }

  /** Record a hook that threw, preserving every previously completed record. */
  recordHookError(plugin: string, err: unknown): ConfigAttributionReport {
    this.order++
    const error = toErrorInfo(err)
    this.failedHook = { plugin, order: this.order, error }
    this.hookRecords.push({
      plugin,
      order: this.order,
      changes: [],
      error,
    })
    return this.getReport()
  }

  /** Build the report (the last hook that touched a path wins). */
  getReport(): ConfigAttributionReport {
    const final: Record<string, ConfigAttributionChange> = {}
    for (const hook of this.hookRecords) {
      for (const change of hook.changes) {
        final[change.path] = change
      }
    }
    const report: ConfigAttributionReport = {
      paths: [...this.paths],
      hooks: this.hookRecords.map(cloneHookRecord),
      final,
    }
    if (this.failedHook) {
      report.failedHook = this.failedHook
    }
    return report
  }

  private summarizePath(
    config: InlineConfig,
    path: string,
  ): ConfigValueSummary {
    const segments = parsePath(path)
    const value = readPath(config, segments)
    if (value.missing) {
      return { type: 'undefined' }
    }
    return summarizeValue(value.value, this.isRedacted(path))
  }

  private isRedacted(path: string): boolean {
    return this.redactedPaths.some(
      (r) => path === r || path.startsWith(r.endsWith('.') ? r : `${r}.`),
    )
  }
}

// ---------------------------------------------------------------------------
// Summaries: values that cannot be serialized stably are represented solely
// by an explicit identity digest. Functions and RegExps are never executed
// (no .call/.apply/.test/.exec) and RegExp patterns are never printed.
// ---------------------------------------------------------------------------

function summarizeValue(value: unknown, redacted: boolean): ConfigValueSummary {
  if (redacted) {
    return { type: typeOf(value), digest: digestOf(value), redacted: true }
  }
  if (value === undefined) return { type: 'undefined' }
  if (value == null) return { type: 'null' }
  switch (typeof value) {
    case 'string':
      return { type: 'string', value }
    case 'number':
    case 'boolean':
      return { type: typeof value, value }
    case 'bigint':
      return { type: 'bigint', digest: digestOf(value) }
    case 'function':
      return { type: 'function', digest: digestOf(value), name: value.name }
    case 'symbol':
      return {
        type: 'symbol',
        digest: digestOf(value),
        name: value.description,
      }
  }
  if (value instanceof RegExp) {
    // Do not print the pattern/source: summarize by identity only.
    return { type: 'regexp', digest: digestOf(value) }
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      valueJson: value.map((v) => summarizeJson(v)),
      digest: digestOf(value),
    }
  }
  if (isPlainContainer(value)) {
    return {
      type: 'object',
      valueJson: summarizeObjectJson(value),
      digest: digestOf(value),
    }
  }
  return {
    type: 'unknown',
    digest: digestOf(value),
    name: value?.constructor?.name,
  }
}

/**
 * JSON-able projection used inside `array`/`object` summaries. Non-stable
 * members are replaced by `{ __unstable, digest }` markers instead of being
 * executed or pattern-stringified.
 */
function summarizeJson(value: unknown): unknown {
  if (value == null) return null
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value
    case 'undefined':
      return { __unstable: 'undefined' }
    case 'bigint':
      return { __unstable: 'bigint', digest: digestOf(value) }
    case 'function':
      return { __unstable: 'function', digest: digestOf(value) }
    case 'symbol':
      return { __unstable: 'symbol', digest: digestOf(value) }
  }
  if (value instanceof RegExp) {
    return { __unstable: 'regexp', digest: digestOf(value) }
  }
  if (Array.isArray(value)) {
    return value.map(summarizeJson)
  }
  if (isPlainContainer(value)) {
    return summarizeObjectJson(value)
  }
  return {
    __unstable: 'unknown',
    digest: digestOf(value),
    name: value?.constructor?.name,
  }
}

function summarizeObjectJson(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj)) {
    out[key] = summarizeJson(obj[key])
  }
  return out
}

function isPlainContainer(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto == null
}

function typeOf(value: unknown): ConfigValueSummary['type'] {
  if (value == null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof RegExp) return 'regexp'
  const t = typeof value
  if (
    t === 'string' ||
    t === 'number' ||
    t === 'boolean' ||
    t === 'bigint' ||
    t === 'function' ||
    t === 'symbol' ||
    t === 'undefined' ||
    t === 'object'
  ) {
    return t
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Path reading
// ---------------------------------------------------------------------------

function parsePath(path: string): string[] {
  return path.split('.').filter((s) => s.length > 0)
}

function readPath(
  root: unknown,
  segments: string[],
): { missing: true } | { missing: false; value: unknown } {
  let current: unknown = root
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      return { missing: true }
    }
    if (!Object.hasOwn(current, segment)) {
      return { missing: true }
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return { missing: false, value: current }
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

function diffSummaries(
  path: string,
  plugin: string,
  order: number,
  before: ConfigValueSummary,
  after: ConfigValueSummary,
): ConfigAttributionChange | null {
  const beforeExists = before.type !== 'undefined'
  const afterExists = after.type !== 'undefined'
  if (!beforeExists && !afterExists) return null
  if (!beforeExists && afterExists) {
    return { path, kind: 'set', plugin, order, after }
  }
  if (beforeExists && !afterExists) {
    return { path, kind: 'delete', plugin, order, before }
  }
  if (!stableEqual(before, after)) {
    return { path, kind: 'replace', plugin, order, before, after }
  }
  return null
}

function stableEqual(a: ConfigValueSummary, b: ConfigValueSummary): boolean {
  if (a.type !== b.type) return false
  if (a.redacted || b.redacted) {
    // Redacted values can only be compared by identity digest (and type).
    return a.digest === b.digest
  }
  if ('value' in a || 'value' in b) {
    return a.value === b.value
  }
  if (a.valueJson !== undefined || b.valueJson !== undefined) {
    return stableJsonEqual(a.valueJson, b.valueJson)
  }
  // Unstable values (functions/RegExp/...): identity comparison only.
  return a.digest === b.digest
}

function stableJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a == null || b == null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false
    }
    return a.every((v, i) => stableJsonEqual(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    if (a instanceof RegExp || b instanceof RegExp) {
      return a === b
    }
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    if (ka.length !== kb.length) return false
    return ka.every(
      (k) =>
        Object.hasOwn(b, k) &&
        stableJsonEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    )
  }
  return false
}

// ---------------------------------------------------------------------------
// Identity digests (never execute the value, never print RegExp source)
// ---------------------------------------------------------------------------

const IDENTITY_TAG: unique symbol = Symbol.for(
  'vite:config-attribution-identity',
)

type IdentityHolder = Record<symbol, number | undefined>

let nextIdentity = 1

/**
 * Assign a stable per-object identity and return its short digest. The digest
 * is derived from an internal monotonic id, so it stays stable for the
 * lifetime of the object across snapshots, while never exposing a function
 * source or a RegExp pattern.
 */
function digestOf(value: unknown): string {
  const t = typeof value
  if (t === 'bigint') {
    return hash(`bigint:${(value as bigint).toString()}`)
  }
  if (value == null || (t !== 'object' && t !== 'function' && t !== 'symbol')) {
    return hash(String(value))
  }
  if (t === 'symbol') {
    return hash(
      `symbol:${(value as symbol).description ?? ''}:${symbolId(value as symbol)}`,
    )
  }
  const holder = value as IdentityHolder
  let id = holder[IDENTITY_TAG]
  if (id === undefined) {
    id = nextIdentity++
    try {
      Object.defineProperty(value as object, IDENTITY_TAG, {
        value: id,
        enumerable: false,
        configurable: false,
        writable: false,
      })
    } catch {
      // Frozen/sealed exotic objects: fall back to a process-local WeakMap.
      id = weakIdentity(value as object)
    }
  }
  return hash(`id:${id}`)
}

const symbolIds = new Map<symbol, number>()

function symbolId(sym: symbol): number {
  let id = symbolIds.get(sym)
  if (id === undefined) {
    id = nextIdentity++
    symbolIds.set(sym, id)
  }
  return id
}

const weakIds = new WeakMap<object, number>()

function weakIdentity(obj: object): number {
  let id = weakIds.get(obj)
  if (id === undefined) {
    id = nextIdentity++
    weakIds.set(obj, id)
  }
  return id
}

function hash(input: string): string {
  return nodeCrypto.createHash('sha1').update(input).digest('hex').slice(0, 10)
}

function toErrorInfo(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message }
  }
  return { name: 'Error', message: String(err) }
}

function cloneHookRecord(
  record: ConfigAttributionHookRecord,
): ConfigAttributionHookRecord {
  return {
    plugin: record.plugin,
    order: record.order,
    changes: record.changes.map((c) => ({ ...c })),
    ...(record.error ? { error: { ...record.error } } : {}),
  }
}
