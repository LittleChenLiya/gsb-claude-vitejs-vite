import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Plugin } from '..'
import { createBuilder } from '../build'
import type { ViteBuilder } from '../build'
import {
  TransactionalPublishError,
  backupDirPrefix,
  stagingDirPrefix,
} from '../transactionalPublish'

const tmpRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    tmpRoots
      .splice(0)
      .map((dir) => fsp.rm(dir, { recursive: true, force: true })),
  )
})

async function createTempProject(): Promise<string> {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'vite-transactional-publish-'),
  )
  tmpRoots.push(root)
  await fsp.writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/client.js"></script></body></html>',
  )
  await fsp.writeFile(
    path.join(root, 'shared.js'),
    "export const shared = 'shared'",
  )
  await fsp.writeFile(
    path.join(root, 'client.js'),
    "import { shared } from './shared.js'; console.log('client', shared)",
  )
  await fsp.writeFile(
    path.join(root, 'ssr-entry.js'),
    "import { shared } from './shared.js'; export const rendered = '<div>' + shared + '</div>'",
  )
  return root
}

function versionPlugin(version: string): Plugin {
  return {
    name: 'test-version',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.txt', source: version })
    },
  }
}

async function createTransactionalBuilder(
  root: string,
  options: {
    publishRoot?: string
    clientOutDir?: string
    ssrOutDir?: string
    version?: string
    plugins?: Plugin[]
  } = {},
): Promise<ViteBuilder> {
  return createBuilder({
    root,
    logLevel: 'silent',
    environments: {
      client: {
        build: {
          outDir: options.clientOutDir ?? 'dist/client',
          manifest: true,
          sourcemap: true,
        },
      },
      ssr: {
        build: {
          outDir: options.ssrOutDir ?? 'dist/server',
          ssr: 'ssr-entry.js',
        },
      },
    },
    builder: {
      transactionalPublish: { publishRoot: options.publishRoot ?? 'dist' },
    },
    plugins: [
      versionPlugin(options.version ?? 'v1'),
      ...(options.plugins ?? []),
    ],
  })
}

async function buildApp(
  root: string,
  version: string,
  plugins: Plugin[] = [],
): Promise<ViteBuilder> {
  const builder = await createTransactionalBuilder(root, {
    version,
    plugins,
  })
  await builder.buildApp()
  return builder
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)))
    } else {
      files.push(entryPath)
    }
  }
  return files
}

async function readVersion(root: string, env: string): Promise<string> {
  return fsp.readFile(path.join(root, 'dist', env, 'version.txt'), 'utf-8')
}

async function listStagingAndBackupDirs(root: string): Promise<string[]> {
  const entries = await fsp.readdir(path.join(root, 'dist'))
  return entries.filter(
    (entry) =>
      entry.startsWith(stagingDirPrefix) || entry.startsWith(backupDirPrefix),
  )
}

describe('transactional publish', () => {
  test('publishes client and ssr outputs atomically on success', async () => {
    const root = await createTempProject()
    const seenOutDirs: string[] = []
    const builder = await buildApp(root, 'v1', [
      {
        name: 'capture-out-dir',
        buildStart(this: any) {
          seenOutDirs.push(this.environment.config.build.outDir)
        },
      },
    ])

    // both environments published
    expect(await readVersion(root, 'client')).toBe('v1')
    expect(await readVersion(root, 'server')).toBe('v1')

    // plugins observed the staging paths during the build, and the
    // configuration is restored afterwards
    expect(seenOutDirs.length).toBeGreaterThan(0)
    for (const outDir of seenOutDirs) {
      expect(outDir).toContain(stagingDirPrefix)
    }
    expect(builder.environments.client.config.build.outDir).toBe('dist/client')
    expect(builder.environments.ssr.config.build.outDir).toBe('dist/server')

    // final links: index.html references an existing hashed asset
    const clientDir = path.join(root, 'dist', 'client')
    const html = await fsp.readFile(path.join(clientDir, 'index.html'), 'utf-8')
    const scriptSrc = html.match(/<script[^>]+src="([^"]+)"/)?.[1]
    expect(scriptSrc).toBeTruthy()
    await fsp.access(path.join(clientDir, scriptSrc!))

    // the manifest references existing files
    const manifest = JSON.parse(
      await fsp.readFile(path.join(clientDir, '.vite/manifest.json'), 'utf-8'),
    )
    const manifestFiles = Object.values(manifest).map(
      (entry: any) => entry.file,
    )
    expect(manifestFiles.length).toBeGreaterThan(0)
    for (const file of manifestFiles) {
      await fsp.access(path.join(clientDir, file))
    }

    // the ssr output can reference the shared module used by the client
    const ssrDir = path.join(root, 'dist', 'server')
    const ssrFiles = await collectFiles(ssrDir)
    const ssrBundle = ssrFiles.find((file) => /\.[cm]?js$/.test(file))!
    expect(await fsp.readFile(ssrBundle, 'utf-8')).toContain('shared')

    // source maps are emitted
    const allFiles = await collectFiles(path.join(root, 'dist'))
    expect(allFiles.some((file) => file.endsWith('.map'))).toBe(true)

    // no staging or backup directories remain, and no output references them
    expect(await listStagingAndBackupDirs(root)).toEqual([])
    for (const file of allFiles) {
      const content = await fsp.readFile(file, 'utf-8')
      expect(content).not.toContain(stagingDirPrefix)
      expect(content).not.toContain(backupDirPrefix)
    }
  })

  test('keeps the previous publish tree when an environment fails to compile', async () => {
    const root = await createTempProject()
    await buildApp(root, 'v1')

    // break the second (ssr) environment
    await fsp.writeFile(
      path.join(root, 'ssr-entry.js'),
      "import './does-not-exist.js'",
    )
    await expect(buildApp(root, 'v2')).rejects.toThrow()

    // the old publish tree is complete and untouched
    expect(await readVersion(root, 'client')).toBe('v1')
    expect(await readVersion(root, 'server')).toBe('v1')
    await fsp.access(path.join(root, 'dist', 'client', 'index.html'))
    expect(await listStagingAndBackupDirs(root)).toEqual([])
  })

  test('keeps the previous publish tree when a closeBundle hook fails', async () => {
    const root = await createTempProject()
    await buildApp(root, 'v1')

    await expect(
      buildApp(root, 'v2', [
        {
          name: 'fail-close-bundle',
          closeBundle() {
            throw new Error('closeBundle failed')
          },
        },
      ]),
    ).rejects.toThrow('closeBundle failed')

    expect(await readVersion(root, 'client')).toBe('v1')
    expect(await readVersion(root, 'server')).toBe('v1')
    expect(await listStagingAndBackupDirs(root)).toEqual([])
  })

  test('restores the previous publish tree when the publish rename fails', async () => {
    const root = await createTempProject()
    await buildApp(root, 'v1')

    const originalRename = fs.promises.rename
    vi.spyOn(fs.promises, 'rename').mockImplementation(
      async (oldPath: any, newPath: any) => {
        if (String(oldPath).includes(stagingDirPrefix)) {
          throw new Error('rename failed')
        }
        return originalRename(oldPath, newPath)
      },
    )

    const error = await buildApp(root, 'v2').catch((e) => e)
    expect(error).toBeInstanceOf(TransactionalPublishError)
    expect(error.phase).toBe('publish')

    // the old tree is fully restored, no half-new half-old result
    expect(await readVersion(root, 'client')).toBe('v1')
    expect(await readVersion(root, 'server')).toBe('v1')
    await fsp.access(path.join(root, 'dist', 'client', 'index.html'))
    expect(await listStagingAndBackupDirs(root)).toEqual([])
  })

  test('keeps the backup when the rollback fails and the next build succeeds', async () => {
    const root = await createTempProject()
    await buildApp(root, 'v1')

    const originalRename = fs.promises.rename
    vi.spyOn(fs.promises, 'rename').mockImplementation(
      async (oldPath: any, newPath: any) => {
        const from = String(oldPath)
        if (from.includes(stagingDirPrefix) || from.includes(backupDirPrefix)) {
          throw new Error('rename failed')
        }
        return originalRename(oldPath, newPath)
      },
    )

    const error = await buildApp(root, 'v2').catch((e) => e)
    expect(error).toBeInstanceOf(TransactionalPublishError)
    expect(error.phase).toBe('rollback')
    expect(error.backupDir).toBeTruthy()
    expect(error.stagingDir).toBeTruthy()

    // the backup with the previous tree and the staging tree are preserved
    const leftovers = await listStagingAndBackupDirs(root)
    expect(leftovers.filter((e) => e.startsWith(backupDirPrefix))).toHaveLength(
      1,
    )
    expect(
      leftovers.filter((e) => e.startsWith(stagingDirPrefix)),
    ).toHaveLength(1)
    const backupDir = leftovers.find((e) => e.startsWith(backupDirPrefix))!
    expect(
      await fsp.readFile(
        path.join(root, 'dist', backupDir, 'client', 'version.txt'),
        'utf-8',
      ),
    ).toBe('v1')
    expect(
      await fsp.readFile(
        path.join(root, 'dist', backupDir, 'server', 'version.txt'),
        'utf-8',
      ),
    ).toBe('v1')

    // the next build succeeds despite the leftover directories
    vi.restoreAllMocks()
    await buildApp(root, 'v3')
    expect(await readVersion(root, 'client')).toBe('v3')
    expect(await readVersion(root, 'server')).toBe('v3')
    await fsp.access(path.join(root, 'dist', 'client', 'index.html'))
  })

  test('rejects invalid publish roots and output directories', async () => {
    const root = await createTempProject()

    // project root as publish root
    await expect(
      (await createTransactionalBuilder(root, { publishRoot: '.' })).buildApp(),
    ).rejects.toThrow(/must not be the project root/)

    // file system root as publish root
    await expect(
      (
        await createTransactionalBuilder(root, {
          publishRoot: path.parse(root).root,
        })
      ).buildApp(),
    ).rejects.toThrow(/must not be a file system root/)

    // output directories outside the publish root
    await expect(
      (
        await createTransactionalBuilder(root, { publishRoot: 'other' })
      ).buildApp(),
    ).rejects.toThrow(/not inside the publishRoot/)

    // output directory equal to the publish root
    await expect(
      (
        await createTransactionalBuilder(root, { clientOutDir: 'dist' })
      ).buildApp(),
    ).rejects.toThrow(/not inside the publishRoot/)

    // overlapping output directories
    await expect(
      (
        await createTransactionalBuilder(root, {
          clientOutDir: 'dist/app',
          ssrOutDir: 'dist/app/server',
        })
      ).buildApp(),
    ).rejects.toThrow(/overlap/)

    // nothing was published
    await expect(fsp.readdir(path.join(root, 'dist'))).rejects.toThrow()
  })

  test('rejects overlapping builds for the same publishRoot', async () => {
    const root = await createTempProject()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowPlugin: Plugin = {
      name: 'slow',
      async buildStart() {
        await gate
      },
    }
    const builder1 = await createTransactionalBuilder(root, {
      plugins: [slowPlugin],
    })
    const builder2 = await createTransactionalBuilder(root)

    const first = builder1.buildApp()
    await expect(builder2.buildApp()).rejects.toThrow(/already publishing/)
    release()
    await first

    expect(await readVersion(root, 'client')).toBe('v1')
    expect(await readVersion(root, 'server')).toBe('v1')
  })
})
