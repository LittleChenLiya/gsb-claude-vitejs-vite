import fs from 'node:fs'
import path from 'node:path'
import type {
  BuildEnvironment,
  ResolvedBuildEnvironmentOptions,
  ViteBuilder,
} from './build'
import { normalizePath } from './utils'
import { getResolvedOutDirs } from './watch'

/**
 * Options for the transactional publish mode of `buildApp`.
 * @experimental
 */
export interface TransactionalPublishOptions {
  /**
   * Directory that contains the output directories of every environment.
   * It must be explicitly configured, must not be the project root or a
   * file system root, and every environment output directory must be a
   * non-overlapping sub directory of it.
   *
   * The directory is resolved relative to the project root.
   */
  publishRoot: string
}

/**
 * The stage of a transactional publish at which a
 * {@link TransactionalPublishError} was raised.
 *
 * - `validate`: the publish root or the output directories are invalid.
 * - `backup`: moving the previous publish tree to the backup failed. The
 *   previous tree was restored.
 * - `publish`: moving the new staging tree into place failed. The
 *   previous tree was restored.
 * - `rollback`: publishing failed and restoring the previous tree also
 *   failed. The previous tree is preserved inside the backup directory and
 *   the new build inside the staging directory (see the `backupDir` and
 *   `stagingDir` properties) so the publish tree can be recovered manually.
 */
export type TransactionalPublishPhase =
  | 'validate'
  | 'backup'
  | 'publish'
  | 'rollback'

/**
 * Error thrown by the transactional publish mode of `buildApp`. The `phase`
 * property indicates the stage at which publishing failed.
 * @experimental
 */
export class TransactionalPublishError extends Error {
  phase: TransactionalPublishPhase
  publishRoot: string
  stagingDir: string | undefined
  backupDir: string | undefined

  constructor(
    phase: TransactionalPublishPhase,
    message: string,
    options: {
      publishRoot: string
      stagingDir?: string
      backupDir?: string
      cause?: unknown
    },
  ) {
    super(message, { cause: options.cause })
    this.name = 'TransactionalPublishError'
    this.phase = phase
    this.publishRoot = options.publishRoot
    this.stagingDir = options.stagingDir
    this.backupDir = options.backupDir
  }
}

/**
 * Prefix of the unique per-build staging directories created inside the
 * publish root while a transactional build is running.
 */
export const stagingDirPrefix = '.vite-staging-'
/**
 * Prefix of the backup directories the previous publish tree is moved to
 * while a transactional publish commits. Leftover directories with this
 * prefix indicate an interrupted publish and can be used to recover the
 * previous publish tree.
 */
export const backupDirPrefix = '.vite-backup-'

const publishRootLocks = new Set<string>()
let uniqueDirectoryCounter = 0

interface PublishEntry {
  environmentName: string
  /** Absolute path of the final output directory. */
  outDir: string
  /** Path of the output directory relative to the publish root. */
  rel: string
  /** Absolute path of the staging directory for this output directory. */
  stagingDir: string
  /** Absolute path of the backup directory for this output directory. */
  backupDir: string
}

/**
 * Runs `runBuildApp` in transactional publish mode. All environments write
 * to a unique staging tree inside `publishRoot` first; once every
 * environment (including finalization hooks such as `closeBundle`) has
 * succeeded, the previous publish tree is moved to a backup and the staging
 * tree is moved into place. See the "Transactional publish" guide for
 * details.
 */
export async function buildAppWithTransactionalPublish(
  builder: ViteBuilder,
  options: TransactionalPublishOptions,
  runBuildApp: () => Promise<void>,
): Promise<void> {
  const { config } = builder
  const publishRoot = path.resolve(config.root, options.publishRoot)

  // In-process mutual exclusion: overlapping builds that publish to the
  // same root are rejected. This does not coordinate across processes.
  const lockKey = normalizePath(publishRoot)
  if (publishRootLocks.has(lockKey)) {
    throw new TransactionalPublishError(
      'validate',
      `Another build is already publishing to ${publishRoot}. ` +
        `Overlapping transactional builds for the same publishRoot are not supported.`,
      { publishRoot },
    )
  }
  publishRootLocks.add(lockKey)
  try {
    const environments = Object.values(builder.environments)
    const entries = resolvePublishPlan(environments, publishRoot)

    const uniqueId = [
      Date.now().toString(36),
      process.pid.toString(36),
      (uniqueDirectoryCounter++).toString(36),
    ].join('-')
    const stagingRoot = path.join(publishRoot, stagingDirPrefix + uniqueId)
    const backupRoot = path.join(publishRoot, backupDirPrefix + uniqueId)
    for (const entry of entries) {
      entry.stagingDir = path.join(stagingRoot, entry.rel)
      entry.backupDir = path.join(backupRoot, entry.rel)
    }
    await fs.promises.mkdir(stagingRoot, { recursive: true })

    const restoreOutDirs = redirectOutDirs(environments, entries)
    let buildError: unknown
    try {
      await runBuildApp()
    } catch (e) {
      buildError = e
    }
    restoreOutDirs()
    if (buildError) {
      // Only this build's staging tree is removed; the previous publish
      // tree was never touched.
      await removeDirSilently(stagingRoot, builder)
      throw buildError
    }

    await commitPublish(entries, publishRoot, stagingRoot, backupRoot, builder)
  } finally {
    publishRootLocks.delete(lockKey)
  }
}

function resolvePublishPlan(
  environments: BuildEnvironment[],
  publishRoot: string,
): PublishEntry[] {
  const fail = (message: string): never => {
    throw new TransactionalPublishError('validate', message, { publishRoot })
  }

  if (environments.length === 0) {
    fail(`Transactional publish requires at least one environment.`)
  }
  const root = environments[0].config.root
  if (normalizePath(publishRoot) === normalizePath(root)) {
    fail(`The publishRoot ${publishRoot} must not be the project root.`)
  }
  if (path.parse(publishRoot).root === publishRoot) {
    fail(`The publishRoot ${publishRoot} must not be a file system root.`)
  }

  const seenBuildOptions = new Set<ResolvedBuildEnvironmentOptions>()
  for (const environment of environments) {
    const buildOptions = environment.config.build
    if (seenBuildOptions.has(buildOptions)) {
      fail(
        `Transactional publish requires per-environment build options ` +
          `and cannot be used with builder.sharedConfigBuild.`,
      )
    }
    seenBuildOptions.add(buildOptions)
    if (buildOptions.watch) {
      fail(`Transactional publish cannot be used with build.watch.`)
    }
  }

  const entries: PublishEntry[] = []
  for (const environment of environments) {
    const buildOptions = environment.config.build
    const outDirs = getResolvedOutDirs(
      environment.config.root,
      buildOptions.outDir,
      buildOptions.rolldownOptions?.output,
    )
    // Also validate the plain outDir even when output.dir overrides are set,
    // so a redirected outDir can never escape the publish root.
    outDirs.add(path.resolve(environment.config.root, buildOptions.outDir))
    for (const outDir of outDirs) {
      const rel = path.relative(publishRoot, outDir)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        fail(
          `The output directory ${outDir} of the "${environment.name}" ` +
            `environment is not inside the publishRoot ${publishRoot}. ` +
            `All output directories must be sub directories of the the publishRoot.`,
        )
      }
      const firstSegment = rel.split(path.sep)[0]
      if (
        firstSegment.startsWith(stagingDirPrefix) ||
        firstSegment.startsWith(backupDirPrefix)
      ) {
        fail(
          `The output directory ${outDir} of the "${environment.name}" ` +
            `environment conflicts with the directories reserved for ` +
            `transactional publishing (${stagingDirPrefix}*, ${backupDirPrefix}*).`,
        )
      }
      entries.push({
        environmentName: environment.name,
        outDir,
        rel,
        stagingDir: '',
        backupDir: '',
      })
    }
  }

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i].outDir
      const b = entries[j].outDir
      if (isSameOrInside(a, b) || isSameOrInside(b, a)) {
        fail(
          `The output directories ${a} and ${b} overlap. ` +
            `Output directories must not contain each other.`,
        )
      }
    }
  }
  return entries
}

function isSameOrInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Points every environment output directory at the staging tree. The
 * staging tree mirrors the layout of the publish root exactly, so relative
 * links between output directories, manifests and source maps are identical
 * to the ones of the final publish tree. Returns a function that restores
 * the original configuration.
 */
function redirectOutDirs(
  environments: BuildEnvironment[],
  entries: PublishEntry[],
): () => void {
  const restore: (() => void)[] = []
  const stagingDirFor = (resolvedOutDir: string): string => {
    const entry = entries.find(
      (entry) => normalizePath(entry.outDir) === normalizePath(resolvedOutDir),
    )
    if (!entry) {
      throw new Error(
        `No staging directory planned for output directory ${resolvedOutDir}.`,
      )
    }
    return entry.stagingDir
  }

  const redirectBuildOptions = (
    environment: BuildEnvironment,
    buildOptions: ResolvedBuildEnvironmentOptions,
  ) => {
    const envRoot = environment.config.root
    const originalOutDir = buildOptions.outDir
    buildOptions.outDir = stagingDirFor(path.resolve(envRoot, originalOutDir))
    restore.push(() => {
      buildOptions.outDir = originalOutDir
    })
    const output = buildOptions.rolldownOptions?.output
    if (output) {
      for (const outputOptions of Array.isArray(output) ? output : [output]) {
        if (outputOptions.dir) {
          const originalDir = outputOptions.dir
          outputOptions.dir = stagingDirFor(path.resolve(envRoot, originalDir))
          restore.push(() => {
            outputOptions.dir = originalDir
          })
        }
      }
    }
  }

  for (const environment of environments) {
    redirectBuildOptions(environment, environment.config.build)
    const recordBuildOptions =
      environment.config.environments[environment.name]?.build
    if (recordBuildOptions && recordBuildOptions !== environment.config.build) {
      redirectBuildOptions(environment, recordBuildOptions)
    }
  }
  return () => {
    for (const restoreOne of restore) restoreOne()
  }
}

async function commitPublish(
  entries: PublishEntry[],
  publishRoot: string,
  stagingRoot: string,
  backupRoot: string,
  builder: ViteBuilder,
): Promise<void> {
  const backedUp: PublishEntry[] = []
  try {
    for (const entry of entries) {
      if (fs.existsSync(entry.outDir)) {
        await fs.promises.mkdir(path.dirname(entry.backupDir), {
          recursive: true,
        })
        await fs.promises.rename(entry.outDir, entry.backupDir)
        backedUp.push(entry)
      }
    }
  } catch (cause) {
    const rollbackErrors = await restoreBackups(backedUp)
    if (rollbackErrors.length > 0) {
      throw new TransactionalPublishError(
        'rollback',
        `Failed to move the previous publish tree to ${backupRoot} and ` +
          `failed to fully restore it. The previous build is preserved at ` +
          `${backupRoot} and the new build at ${stagingRoot}.`,
        { publishRoot, stagingDir: stagingRoot, backupDir: backupRoot, cause },
      )
    }
    await removeDirSilently(stagingRoot, builder)
    await removeDirSilently(backupRoot, builder)
    throw new TransactionalPublishError(
      'backup',
      `Failed to move the previous publish tree to ${backupRoot}. ` +
        `The previous publish tree has been restored.`,
      { publishRoot, stagingDir: stagingRoot, backupDir: backupRoot, cause },
    )
  }

  const published: PublishEntry[] = []
  const restored: PublishEntry[] = []
  try {
    for (const entry of entries) {
      if (fs.existsSync(entry.stagingDir)) {
        await fs.promises.mkdir(path.dirname(entry.outDir), {
          recursive: true,
        })
        await fs.promises.rename(entry.stagingDir, entry.outDir)
        published.push(entry)
      } else if (backedUp.includes(entry)) {
        // The environment did not write any output; keep the previous tree.
        await fs.promises.rename(entry.backupDir, entry.outDir)
        restored.push(entry)
      }
    }
  } catch (cause) {
    const rollbackErrors: unknown[] = []
    for (const entry of published.reverse()) {
      try {
        await fs.promises.rename(entry.outDir, entry.stagingDir)
      } catch (e) {
        rollbackErrors.push(e)
      }
    }
    for (const entry of restored.reverse()) {
      try {
        await fs.promises.rename(entry.outDir, entry.backupDir)
      } catch (e) {
        rollbackErrors.push(e)
      }
    }
    rollbackErrors.push(
      ...(await restoreBackups(backedUp.filter((e) => !restored.includes(e)))),
    )
    if (rollbackErrors.length > 0) {
      // Keep both directories so a usable tree can be recovered manually.
      throw new TransactionalPublishError(
        'rollback',
        `Failed to publish the new build and failed to fully restore the ` +
          `previous publish tree. The previous build is preserved at ` +
          `${backupRoot} and the new build at ${stagingRoot}.`,
        { publishRoot, stagingDir: stagingRoot, backupDir: backupRoot, cause },
      )
    }
    // The previous tree is back in place; the unpublished staging tree can
    // be discarded safely.
    await removeDirSilently(stagingRoot, builder)
    await removeDirSilently(backupRoot, builder)
    throw new TransactionalPublishError(
      'publish',
      `Failed to publish the new build. The previous publish tree has ` +
        `been restored.`,
      { publishRoot, stagingDir: stagingRoot, backupDir: backupRoot, cause },
    )
  }

  await removeDirSilently(backupRoot, builder)
  await removeDirSilently(stagingRoot, builder)
}

async function restoreBackups(backedUp: PublishEntry[]): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const entry of backedUp.toReversed()) {
    try {
      await fs.promises.mkdir(path.dirname(entry.outDir), { recursive: true })
      await fs.promises.rename(entry.backupDir, entry.outDir)
    } catch (e) {
      errors.push(e)
    }
  }
  return errors
}

async function removeDirSilently(
  dir: string,
  builder: ViteBuilder,
): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true })
  } catch (e) {
    builder.config.logger.warn(
      `Failed to remove the temporary directory ${dir}: ${(e as Error).message}`,
    )
  }
}
