import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path, { basename, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import colors from 'picocolors'
import type {
  LogLevel,
  OutputAsset,
  OutputChunk,
  OutputOptions,
  RolldownOptions,
  RolldownOutput,
  RollupLog,
} from 'rolldown'
import { afterEach, describe, expect, assert, test, vi } from 'vitest'
import { BuildEnvironment, normalizePath, resolveConfig } from '..'
import type { InlineConfig } from '..'
import type { LibraryFormats, LibraryOptions } from '../build'
import {
  ChunkMetadataMap,
  TransactionalPublishError,
  build,
  createBuilder,
  onRollupLog,
  resolveBuildOutputs,
  resolveLibFilename,
  resolveRolldownOptions,
} from '../build'
import type { Logger } from '../logger'
import { createLogger } from '../logger'

const dirname = import.meta.dirname

type FormatsToFileNames = [LibraryFormats, string][]

describe('build', () => {
  test('file hash should change when css changes for dynamic entries', async () => {
    const buildProject = async (cssColor: string) => {
      return (await build({
        root: resolve(dirname, 'packages/build-project'),
        logLevel: 'silent',
        build: {
          write: false,
        },
        plugins: [
          {
            name: 'test',
            resolveId(id) {
              if (
                id === 'entry.js' ||
                id === 'subentry.js' ||
                id === 'foo.css'
              ) {
                return '\0' + id
              }
            },
            load(id) {
              if (id === '\0entry.js') {
                return `window.addEventListener('click', () => { import('subentry.js') });`
              }
              if (id === '\0subentry.js') {
                return `import 'foo.css'`
              }
              if (id === '\0foo.css') {
                return `.foo { color: ${cssColor} }`
              }
            },
          },
        ],
      })) as RolldownOutput
    }
    const result = await Promise.all([
      buildProject('red'),
      buildProject('blue'),
    ])
    expect(getOutputHashChanges(result[0], result[1])).toMatchInlineSnapshot(`
      {
        "changed": [
          "index",
          "_subentry.css",
        ],
        "unchanged": [
          "undefined",
        ],
      }
    `)
    assertOutputHashContentChange(result[0], result[1])
  })

  test('file hash should change when renderBuiltUrl changes', async () => {
    const createRenderBuiltUrl = (base: string) => (filename: string) =>
      `${base}/${filename}`
    const renderBuiltUrlA = createRenderBuiltUrl('/cdn-a')
    const renderBuiltUrlB = createRenderBuiltUrl('/cdn-b')

    expect(renderBuiltUrlA.toString()).toBe(renderBuiltUrlB.toString())

    const result = await Promise.all([
      buildProjectWithRenderBuiltUrl(renderBuiltUrlA),
      buildProjectWithRenderBuiltUrl(renderBuiltUrlB),
    ])

    expect(getOutputHashChanges(result[0], result[1])).toMatchInlineSnapshot(`
      {
        "changed": [
          "index",
        ],
        "unchanged": [
          "_subentry",
          "asset.txt",
          "undefined",
        ],
      }
    `)
    assertOutputHashContentChange(result[0], result[1])
  })

  test('top-level input is used as the default build entry', async () => {
    const result = (await build({
      root: resolve(dirname, 'packages/build-project'),
      logLevel: 'silent',
      input: 'top-level-entry.js',
      build: {
        write: false,
      },
      plugins: [
        {
          name: 'test',
          resolveId(id) {
            if (id.replace(/\\/g, '/').endsWith('top-level-entry.js')) {
              return '\0top-level-entry.js'
            }
          },
          load(id) {
            if (id === '\0top-level-entry.js') {
              return `console.log('from-top-level-input')`
            }
          },
        },
      ],
    })) as RolldownOutput
    const chunk = result.output.find((o) => o.type === 'chunk')
    expect(chunk?.fileName).toContain('top-level-entry')
    expect(chunk?.code).toContain('from-top-level-input')
  })

  test('top-level input can be a virtual module for build', async () => {
    const input = 'virtual:entry'
    const resolvedInput = `\0${input}`
    const result = (await build({
      root: resolve(dirname, 'packages/build-project'),
      logLevel: 'silent',
      input,
      build: {
        write: false,
      },
      plugins: [
        {
          name: 'virtual-entry',
          resolveId(id) {
            if (id === input) {
              return resolvedInput
            }
          },
          load(id) {
            if (id === resolvedInput) {
              return `console.log('from-virtual-top-level-input')`
            }
          },
        },
      ],
    })) as RolldownOutput
    const chunk = result.output.find((o) => o.type === 'chunk')
    expect(chunk?.code).toContain('from-virtual-top-level-input')
  })

  test('file hash should change when pure css chunk changes', async () => {
    const buildProject = async (cssColor: string) => {
      return (await build({
        root: resolve(dirname, 'packages/build-project'),
        logLevel: 'silent',
        build: {
          write: false,
        },
        plugins: [
          {
            name: 'test',
            resolveId(id) {
              if (
                id === 'entry.js' ||
                id === 'foo.js' ||
                id === 'bar.js' ||
                id === 'baz.js' ||
                id === 'foo.css' ||
                id === 'bar.css' ||
                id === 'baz.css'
              ) {
                return '\0' + id
              }
            },
            load(id) {
              if (id === '\0entry.js') {
                return `
                  window.addEventListener('click', () => { import('foo.js') });
                  window.addEventListener('click', () => { import('bar.js') });`
              }
              if (id === '\0foo.js') return `import 'foo.css'; import 'baz.js'`
              if (id === '\0bar.js') return `import 'bar.css'; import 'baz.js'`
              if (id === '\0baz.js') return `import 'baz.css'`
              if (id === '\0foo.css') return `.foo { color: red }`
              if (id === '\0bar.css') return `.foo { color: green }`
              if (id === '\0baz.css') return `.foo { color: ${cssColor} }`
            },
          },
        ],
      })) as RolldownOutput
    }
    const result = await Promise.all([
      buildProject('yellow'),
      buildProject('blue'),
    ])
    expect(getOutputHashChanges(result[0], result[1])).toMatchInlineSnapshot(`
      {
        "changed": [
          "index",
          "_bar",
          "_foo",
          "_baz.css",
        ],
        "unchanged": [
          "_bar.css",
          "_foo.css",
          "undefined",
        ],
      }
    `)
    assertOutputHashContentChange(result[0], result[1])
  })

  test('css entries with the same basename should not cross-link manifest assets', async () => {
    const root = resolve(dirname, 'fixtures/css-entry-same-basename')
    const result = (await build({
      root,
      logLevel: 'silent',
      build: {
        write: false,
        manifest: true,
        assetsInlineLimit: 0,
        rolldownOptions: {
          input: [resolve(root, 'a/index.css'), resolve(root, 'b/index.css')],
        },
      },
    })) as RolldownOutput

    const manifest = JSON.parse(
      (result.output.find((o) => o.fileName === '.vite/manifest.json') as any)
        .source,
    )
    expect(manifest['a/index.css']).toMatchObject({
      isEntry: true,
    })
    expect(manifest['b/index.css']).toMatchObject({
      isEntry: true,
    })
  })

  test.for([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
    ['auto', true],
    ['auto', false],
  ] as const)(
    'large json object files should have tree-shaking (json.stringify: %s, json.namedExports: %s)',
    async ([stringify, namedExports]) => {
      const esBundle = (await build({
        mode: 'development',
        root: resolve(dirname, 'packages/build-project'),
        logLevel: 'silent',
        json: { stringify, namedExports },
        build: {
          minify: false,
          modulePreload: { polyfill: false },
          write: false,
        },
        plugins: [
          {
            name: 'test',
            resolveId(id) {
              if (
                id === 'entry.js' ||
                id === 'object.json' ||
                id === 'array.json'
              ) {
                return '\0' + id
              }
            },
            load(id) {
              if (id === '\0entry.js') {
                return `
                  import object from 'object.json';
                  import array from 'array.json';
                  console.log();
                `
              }
              if (id === '\0object.json') {
                return `
                  {"value": {"${stringify}_${namedExports}":"JSON_OBJ${'_'.repeat(10_000)}"}}
                `
              }
              if (id === '\0array.json') {
                return `
                  ["${stringify}_${namedExports}","JSON_ARR${'_'.repeat(10_000)}"]
                `
              }
            },
          },
        ],
      })) as RolldownOutput

      const foo = esBundle.output.find(
        (chunk) => chunk.type === 'chunk' && chunk.isEntry,
      ) as OutputChunk
      expect(foo.code).not.contains('JSON_ARR')
      expect(foo.code).not.contains('JSON_OBJ')
    },
  )

  test('external modules should not be hoisted in library build', async () => {
    const [esBundle] = (await build({
      logLevel: 'silent',
      build: {
        lib: {
          entry: ['foo.js', 'bar.js'],
          formats: ['es'],
        },
        rolldownOptions: {
          external: 'external',
        },
        write: false,
      },
      plugins: [
        {
          name: 'test',
          resolveId(id) {
            const name = basename(id)
            if (name === 'foo.js' || name === 'bar.js') {
              return name
            }
          },
          load(id) {
            if (id === 'foo.js') {
              return `
                  import bar from 'bar.js'
                  export default bar()
                `
            }
            if (id === 'bar.js') {
              return `
                  import ext from 'external';
                  export default ext();`
            }
          },
        },
      ],
    })) as RolldownOutput[]

    const foo = esBundle.output.find(
      (chunk) => chunk.fileName === 'foo.js',
    ) as OutputChunk
    expect(foo.code).not.contains('import "external"')
  })
})

const baseLibOptions: LibraryOptions = {
  fileName: 'my-lib',
  entry: 'mylib.js',
}

describe('resolveBuildOutputs', () => {
  test('resolves outputs correctly', () => {
    const logger = createLogger()
    const libOptions: LibraryOptions = { ...baseLibOptions }
    const outputs: OutputOptions[] = [{ format: 'es' }]
    const resolvedOutputs = resolveBuildOutputs(outputs, libOptions, logger)

    expect(resolvedOutputs).toEqual([
      {
        format: 'es',
      },
    ])
  })

  test('resolves outputs from lib options', () => {
    const logger = createLogger()
    const libOptions: LibraryOptions = { ...baseLibOptions, name: 'lib' }
    const resolvedOutputs = resolveBuildOutputs(void 0, libOptions, logger)

    expect(resolvedOutputs).toEqual([
      {
        format: 'es',
      },
      {
        format: 'umd',
      },
    ])
  })

  test('does not change outputs when lib options are missing', () => {
    const logger = createLogger()
    const outputs: OutputOptions[] = [{ format: 'es' }]
    const resolvedOutputs = resolveBuildOutputs(outputs, false, logger)

    expect(resolvedOutputs).toEqual(outputs)
  })

  test('logs a warning when outputs is an array and formats are specified', () => {
    const logger = createLogger()
    const loggerSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const libOptions: LibraryOptions = {
      ...baseLibOptions,
      formats: ['iife'],
    }
    const outputs: OutputOptions[] = [{ format: 'es' }]

    resolveBuildOutputs(outputs, libOptions, logger)

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('"build.lib.formats" will be ignored because'),
    )
  })

  test('throws an error when lib.name is missing on iife format', () => {
    const logger = createLogger()
    const libOptions: LibraryOptions = {
      ...baseLibOptions,
      formats: ['iife'],
    }
    const resolveBuild = () => resolveBuildOutputs(void 0, libOptions, logger)

    expect(resolveBuild).toThrowError(/Option "build\.lib\.name" is required/)
  })

  test('throws an error when lib.name is missing on umd format', () => {
    const logger = createLogger()
    const libOptions: LibraryOptions = { ...baseLibOptions, formats: ['umd'] }
    const resolveBuild = () => resolveBuildOutputs(void 0, libOptions, logger)

    expect(resolveBuild).toThrowError(/Option "build\.lib\.name" is required/)
  })

  test('throws an error when output.name is missing on iife format', () => {
    const logger = createLogger()
    const libOptions: LibraryOptions = { ...baseLibOptions }
    const outputs: OutputOptions[] = [{ format: 'iife' }]
    const resolveBuild = () => resolveBuildOutputs(outputs, libOptions, logger)

    expect(resolveBuild).toThrowError(
      /Entries in "build\.rolldownOptions\.output" must specify "name"/,
    )
  })

  test('throws an error when output.name is missing on umd format', () => {
    const logger = createLogger()
    const libOptions: LibraryOptions = { ...baseLibOptions }
    const outputs: OutputOptions[] = [{ format: 'umd' }]
    const resolveBuild = () => resolveBuildOutputs(outputs, libOptions, logger)

    expect(resolveBuild).toThrowError(
      /Entries in "build\.rolldownOptions\.output" must specify "name"/,
    )
  })

  describe('input resolution in resolveRolldownOptions', () => {
    const buildProjectRoot = resolve(dirname, 'packages/build-project')

    test('build.rolldownOptions.input takes precedence over top-level input', async () => {
      const builder = await createBuilder({
        root: buildProjectRoot,
        logLevel: 'silent',
        input: 'top-level-entry.js',
        build: {
          rolldownOptions: { input: 'explicit-entry.js' },
        },
      })
      const options = resolveRolldownOptions(
        builder.environments.client,
        new ChunkMetadataMap(),
      )
      expect(options.input).toBe('explicit-entry.js')
    })

    test('top-level tsconfig applies to Rolldown options', async () => {
      const builder = await createBuilder({
        root: buildProjectRoot,
        logLevel: 'silent',
        tsconfig: './custom.tsconfig.json',
        build: {
          rolldownOptions: {
            tsconfig: './other.tsconfig.json',
            resolve: { tsconfigFilename: './legacy.tsconfig.json' },
          },
        },
      })
      const options = resolveRolldownOptions(
        builder.environments.client,
        new ChunkMetadataMap(),
      )
      expect(options.tsconfig).toBe(
        normalizePath(resolve(buildProjectRoot, 'custom.tsconfig.json')),
      )
      expect(options.resolve?.tsconfigFilename).toBeUndefined()
    })

    test('falls back to index.html when no input is set', async () => {
      const builder = await createBuilder({
        root: buildProjectRoot,
        logLevel: 'silent',
      })
      const options = resolveRolldownOptions(
        builder.environments.client,
        new ChunkMetadataMap(),
      )
      expect(options.input).toBe(resolve(buildProjectRoot, 'index.html'))
    })

    test('build.ssr string entry takes precedence over input', async () => {
      const builder = await createBuilder({
        root: buildProjectRoot,
        logLevel: 'silent',
        environments: {
          ssr: {
            input: 'env-input.js',
            build: { ssr: 'ssr-entry.js' },
          },
        },
      })
      const options = resolveRolldownOptions(
        builder.environments.ssr,
        new ChunkMetadataMap(),
      )
      expect(options.input).toBe(resolve(buildProjectRoot, 'ssr-entry.js'))
    })

    test('throws when build.lib is set without entry or top-level input', async () => {
      const builder = await createBuilder({
        root: buildProjectRoot,
        logLevel: 'silent',
        build: {
          lib: { name: 'MyLib', formats: ['es'] },
        },
      })
      expect(() =>
        resolveRolldownOptions(
          builder.environments.client,
          new ChunkMetadataMap(),
        ),
      ).toThrow(
        /Either "build\.lib\.entry" or the top-level "input" option is required/,
      )
    })
  })
})

describe('resolveLibFilename', () => {
  test('custom filename function', () => {
    const filename = resolveLibFilename(
      {
        fileName: (format) => `custom-filename-function.${format}.js`,
        entry: 'mylib.js',
      },
      'es',
      'myLib',
      resolve(dirname, 'packages/name'),
    )

    expect(filename).toBe('custom-filename-function.es.js')
  })

  test('custom filename string', () => {
    const filename = resolveLibFilename(
      {
        fileName: 'custom-filename',
        entry: 'mylib.js',
      },
      'es',
      'myLib',
      resolve(dirname, 'packages/name'),
    )

    expect(filename).toBe('custom-filename.mjs')
  })

  test('package name as filename', () => {
    const filename = resolveLibFilename(
      {
        entry: 'mylib.js',
      },
      'es',
      'myLib',
      resolve(dirname, 'packages/name'),
    )

    expect(filename).toBe('mylib.mjs')
  })

  test('custom filename and no package name', () => {
    const filename = resolveLibFilename(
      {
        fileName: 'custom-filename',
        entry: 'mylib.js',
      },
      'es',
      'myLib',
      resolve(dirname, 'packages/noname'),
    )

    expect(filename).toBe('custom-filename.mjs')
  })

  test('missing filename', () => {
    const filename = resolveLibFilename(
      {
        entry: 'mylib.js',
      },
      'es',
      'myLib',
      resolve(dirname, 'packages/noname'),
    )
    expect(filename).toBe('named-testing-package.mjs')
  })

  test('commonjs package extensions', () => {
    const formatsToFilenames: FormatsToFileNames = [
      ['es', 'my-lib.mjs'],
      ['umd', 'my-lib.umd.js'],
      ['cjs', 'my-lib.js'],
      ['iife', 'my-lib.iife.js'],
    ]

    for (const [format, expectedFilename] of formatsToFilenames) {
      const filename = resolveLibFilename(
        baseLibOptions,
        format,
        'myLib',
        resolve(dirname, 'packages/noname'),
      )

      expect(filename).toBe(expectedFilename)
    }
  })

  test('module package extensions', () => {
    const formatsToFilenames: FormatsToFileNames = [
      ['es', 'my-lib.js'],
      ['umd', 'my-lib.umd.cjs'],
      ['cjs', 'my-lib.cjs'],
      ['iife', 'my-lib.iife.js'],
    ]

    for (const [format, expectedFilename] of formatsToFilenames) {
      const filename = resolveLibFilename(
        baseLibOptions,
        format,
        'myLib',
        resolve(dirname, 'packages/module'),
      )

      expect(expectedFilename).toBe(filename)
    }
  })

  test('multiple entries with aliases', () => {
    const libOptions: LibraryOptions = {
      entry: {
        entryA: 'entryA.js',
        entryB: 'entryB.js',
      },
    }

    const [fileName1, fileName2] = ['entryA', 'entryB'].map((entryAlias) =>
      resolveLibFilename(
        libOptions,
        'es',
        entryAlias,
        resolve(dirname, 'packages/name'),
      ),
    )

    expect(fileName1).toBe('entryA.mjs')
    expect(fileName2).toBe('entryB.mjs')
  })

  test('multiple entries with aliases: custom filename function', () => {
    const libOptions: LibraryOptions = {
      entry: {
        entryA: 'entryA.js',
        entryB: 'entryB.js',
      },
      fileName: (format, entryAlias) =>
        `custom-filename-function.${entryAlias}.${format}.js`,
    }

    const [fileName1, fileName2] = ['entryA', 'entryB'].map((entryAlias) =>
      resolveLibFilename(
        libOptions,
        'es',
        entryAlias,
        resolve(dirname, 'packages/name'),
      ),
    )

    expect(fileName1).toBe('custom-filename-function.entryA.es.js')
    expect(fileName2).toBe('custom-filename-function.entryB.es.js')
  })

  test('multiple entries with aliases: custom filename string', () => {
    const libOptions: LibraryOptions = {
      entry: {
        entryA: 'entryA.js',
        entryB: 'entryB.js',
      },
      fileName: 'custom-filename',
    }

    const [fileName1, fileName2] = ['entryA', 'entryB'].map((entryAlias) =>
      resolveLibFilename(
        libOptions,
        'es',
        entryAlias,
        resolve(dirname, 'packages/name'),
      ),
    )

    expect(fileName1).toBe('custom-filename.mjs')
    expect(fileName2).toBe('custom-filename.mjs')
  })

  test('multiple entries as array', () => {
    const libOptions: LibraryOptions = {
      entry: ['entryA.js', 'entryB.js'],
    }

    const [fileName1, fileName2] = ['entryA', 'entryB'].map((entryAlias) =>
      resolveLibFilename(
        libOptions,
        'es',
        entryAlias,
        resolve(dirname, 'packages/name'),
      ),
    )

    expect(fileName1).toBe('entryA.mjs')
    expect(fileName2).toBe('entryB.mjs')
  })

  test('multiple entries as array: custom filename function', () => {
    const libOptions: LibraryOptions = {
      entry: ['entryA.js', 'entryB.js'],
      fileName: (format, entryAlias) =>
        `custom-filename-function.${entryAlias}.${format}.js`,
    }

    const [fileName1, fileName2] = ['entryA', 'entryB'].map((entryAlias) =>
      resolveLibFilename(
        libOptions,
        'es',
        entryAlias,
        resolve(dirname, 'packages/name'),
      ),
    )

    expect(fileName1).toBe('custom-filename-function.entryA.es.js')
    expect(fileName2).toBe('custom-filename-function.entryB.es.js')
  })

  test('multiple entries as array: custom filename string', () => {
    const libOptions: LibraryOptions = {
      entry: ['entryA.js', 'entryB.js'],
      fileName: 'custom-filename',
    }

    const [fileName1, fileName2] = ['entryA', 'entryB'].map((entryAlias) =>
      resolveLibFilename(
        libOptions,
        'es',
        entryAlias,
        resolve(dirname, 'packages/name'),
      ),
    )

    expect(fileName1).toBe('custom-filename.mjs')
    expect(fileName2).toBe('custom-filename.mjs')
  })
})

describe('resolveBuildOutputs', () => {
  test('default format: one entry', () => {
    const libOptions: LibraryOptions = {
      entry: 'entryA.js',
      name: 'entryA',
    }

    expect(resolveBuildOutputs(undefined, libOptions, {} as Logger)).toEqual([
      { format: 'es' },
      { format: 'umd' },
    ])
    expect(
      resolveBuildOutputs({ name: 'A' }, libOptions, {} as Logger),
    ).toEqual([
      { format: 'es', name: 'A' },
      { format: 'umd', name: 'A' },
    ])
    expect(
      resolveBuildOutputs([{ name: 'A' }], libOptions, {} as Logger),
    ).toEqual([{ name: 'A' }])
  })

  test('default format: multiple entries', () => {
    const libOptions: LibraryOptions = {
      entry: ['entryA.js', 'entryB.js'],
    }

    expect(resolveBuildOutputs(undefined, libOptions, {} as Logger)).toEqual([
      { format: 'es' },
      { format: 'cjs' },
    ])
    expect(
      resolveBuildOutputs({ name: 'A' }, libOptions, {} as Logger),
    ).toEqual([
      { format: 'es', name: 'A' },
      { format: 'cjs', name: 'A' },
    ])
    expect(
      resolveBuildOutputs([{ name: 'A' }], libOptions, {} as Logger),
    ).toEqual([{ name: 'A' }])
  })

  test('umd or iife: should not support multiple entries', () => {
    ;['umd', 'iife'].forEach((format) => {
      expect(() =>
        resolveBuildOutputs(
          undefined,
          {
            entry: ['entryA.js', 'entryB.js'],
            formats: [format as LibraryFormats],
          },
          {} as Logger,
        ),
      ).toThrow(
        `Multiple entry points are not supported when output formats include "umd" or "iife".`,
      )
    })
  })

  test('umd or iife: should define build.lib.name', () => {
    ;['umd', 'iife'].forEach((format) => {
      expect(() =>
        resolveBuildOutputs(
          undefined,
          {
            entry: 'entryA.js',
            formats: [format as LibraryFormats],
          },
          {} as Logger,
        ),
      ).toThrow(
        `Option "build.lib.name" is required when output formats include "umd" or "iife".`,
      )
    })
  })

  test('array outputs: should ignore build.lib.formats', () => {
    const log = { warn: vi.fn() } as unknown as Logger
    expect(
      resolveBuildOutputs(
        [{ name: 'A' }],
        {
          entry: 'entryA.js',
          formats: ['es'],
        },
        log,
      ),
    ).toEqual([{ name: 'A' }])
    expect(log.warn).toHaveBeenLastCalledWith(
      colors.yellow(
        `"build.lib.formats" will be ignored because "build.rolldownOptions.output" is already an array format.`,
      ),
    )
  })

  test('ssrEmitAssets', async () => {
    const result = await build({
      root: resolve(dirname, 'fixtures/emit-assets'),
      logLevel: 'silent',
      build: {
        ssr: true,
        ssrEmitAssets: true,
        rolldownOptions: {
          input: {
            index: '/entry',
          },
        },
      },
    })
    expect(result).toMatchObject({
      output: [
        {
          fileName: 'index.mjs',
        },
        {
          fileName: expect.stringMatching(/assets\/index-[-\w]{8}\.css/),
        },
      ],
    })
  })

  test('emitAssets', async () => {
    const builder = await createBuilder({
      root: resolve(dirname, 'fixtures/emit-assets'),
      logLevel: 'warn',
      environments: {
        ssr: {
          build: {
            ssr: true,
            emitAssets: true,
            rolldownOptions: {
              input: {
                index: '/entry',
              },
            },
          },
        },
      },
    })
    const result = await builder.build(builder.environments.ssr)
    expect(result).toMatchObject({
      output: [
        {
          fileName: 'index.mjs',
        },
        {
          fileName: expect.stringMatching(/assets\/index-[-\w]{8}\.css/),
        },
      ],
    })
  })

  test('ssr builtin', async () => {
    const builder = await createBuilder({
      root: resolve(dirname, 'fixtures/dynamic-import'),
      logLevel: 'warn',
      environments: {
        ssr: {
          build: {
            ssr: true,
            rolldownOptions: {
              input: {
                index: '/entry',
              },
            },
          },
        },
      },
    })
    const result = await builder.build(builder.environments.ssr)
    expect((result as RolldownOutput).output[0].code).not.toContain('preload')
  })

  test('ssr custom', async () => {
    const builder = await createBuilder({
      root: resolve(dirname, 'fixtures/dynamic-import'),
      logLevel: 'warn',
      environments: {
        custom: {
          build: {
            ssr: true,
            rolldownOptions: {
              input: {
                index: '/entry',
              },
            },
          },
        },
      },
    })
    const result = await builder.build(builder.environments.custom)
    expect((result as RolldownOutput).output[0].code).not.toContain('preload')
  })
})

test('default sharedConfigBuild true on build api', async () => {
  let counter = 0
  await build({
    root: resolve(dirname, 'fixtures/emit-assets'),
    logLevel: 'warn',
    build: {
      ssr: true,
      rolldownOptions: {
        input: {
          index: '/entry',
        },
      },
    },
    plugins: [
      {
        name: 'test-plugin',
        config() {
          counter++
        },
      },
    ],
  })
  expect(counter).toBe(1)
})

test.for([true, false])(
  'minify per environment (builder.sharedPlugins: %s)',
  async (sharedPlugins) => {
    const root = resolve(dirname, 'fixtures/shared-plugins/minify')
    const builder = await createBuilder({
      root,
      logLevel: 'warn',
      environments: {
        client: {
          build: {
            outDir: './dist/client',
            rolldownOptions: {
              input: '/entry.js',
            },
          },
        },
        ssr: {
          build: {
            outDir: './dist/server',
            rolldownOptions: {
              input: '/entry.js',
            },
          },
        },
        custom1: {
          build: {
            minify: true,
            outDir: './dist/custom1',
            rolldownOptions: {
              input: '/entry.js',
            },
          },
        },
        custom2: {
          build: {
            minify: false,
            outDir: './dist/custom2',
            rolldownOptions: {
              input: '/entry.js',
            },
          },
        },
      },
      builder: {
        sharedPlugins,
      },
    })
    const client = await builder.build(builder.environments.client)
    const ssr = await builder.build(builder.environments.ssr)
    const custom1 = await builder.build(builder.environments.custom1)
    const custom2 = await builder.build(builder.environments.custom2)
    expect(
      ([client, ssr, custom1, custom2] as RolldownOutput[]).map(
        (o) => o.output[0].code.split('\n').length,
      ),
    ).toEqual([1, 8, 1, 8])
  },
)

test('chunkImportMap per environment with shared plugins', async () => {
  const root = resolve(dirname, 'fixtures/shared-plugins/chunk-import-map')
  let client: RolldownOutput | undefined
  let ssr: RolldownOutput | undefined
  const builder = await createBuilder({
    root,
    logLevel: 'warn',
    environments: {
      client: {
        build: {
          chunkImportMap: true,
          write: false,
          rolldownOptions: {
            input: '/entry.js',
          },
        },
      },
      ssr: {
        build: {
          chunkImportMap: false,
          ssr: true,
          write: false,
          rolldownOptions: {
            input: '/entry.js',
          },
        },
      },
    },
    builder: {
      sharedPlugins: true,
      async buildApp(builder) {
        client = (await builder.build(
          builder.environments.client,
        )) as RolldownOutput
        ssr = (await builder.build(builder.environments.ssr)) as RolldownOutput
      },
    },
  })

  await builder.buildApp()

  const entry = client!.output.find(
    (output): output is OutputChunk =>
      output.type === 'chunk' && output.isEntry,
  )!
  const css = client!.output.find(
    (output) => output.type === 'asset' && output.fileName.endsWith('.css'),
  )!
  const importMapAsset = client!.output.find(
    (output): output is OutputAsset =>
      output.type === 'asset' && output.fileName === 'importmap.json',
  )!
  expect(
    ssr!.output.some(
      (output) =>
        output.type === 'asset' && output.fileName === 'importmap.json',
    ),
  ).toBe(false)
  const importMap = JSON.parse(importMapAsset.source.toString())
    .imports as Record<string, string>
  const cssSpecifier = Object.entries(importMap).find(
    ([, fileName]) => fileName === `/${css.fileName}`,
  )![0]
  expect(entry.code).toContain(JSON.stringify(cssSpecifier.slice(1)))
})

test('chunkImportMap is emitted when emitAssets is false', async () => {
  const root = resolve(dirname, 'fixtures/shared-plugins/chunk-import-map')
  const builder = await createBuilder({
    root,
    logLevel: 'warn',
    environments: {
      ssr: {
        build: {
          ssr: true,
          emitAssets: false,
          write: false,
          chunkImportMap: true,
          rolldownOptions: {
            input: '/entry.js',
            experimental: {
              chunkImportMap: {
                fileName: 'custom-importmap.json',
              },
            },
          },
        },
      },
    },
  })

  const result = (await builder.build(
    builder.environments.ssr,
  )) as RolldownOutput

  expect(result.output).toContainEqual(
    expect.objectContaining({
      type: 'asset',
      fileName: 'custom-importmap.json',
    }),
  )
})

test('chunkImportMap is emitted for SSR when enabled', async () => {
  const root = resolve(dirname, 'fixtures/shared-plugins/chunk-import-map')
  const builder = await createBuilder({
    root,
    logLevel: 'warn',
    environments: {
      ssr: {
        build: {
          ssr: true,
          chunkImportMap: true,
          write: false,
          rolldownOptions: {
            input: '/entry.js',
          },
        },
      },
    },
  })

  const result = (await builder.build(
    builder.environments.ssr,
  )) as RolldownOutput

  expect(result.output).toContainEqual(
    expect.objectContaining({
      type: 'asset',
      fileName: 'importmap.json',
    }),
  )
})

test('importmap named asset is not emitted when chunkImportMap is false', async () => {
  const root = resolve(dirname, 'fixtures/shared-plugins/chunk-import-map')
  const builder = await createBuilder({
    root,
    logLevel: 'warn',
    plugins: [
      {
        name: 'emit-importmap-named-asset',
        buildStart() {
          this.emitFile({
            type: 'asset',
            fileName: 'importmap.json',
            source: '{}',
          })
        },
      },
    ],
    environments: {
      ssr: {
        build: {
          ssr: true,
          emitAssets: false,
          write: false,
          rolldownOptions: {
            input: '/entry.js',
          },
        },
      },
    },
  })

  const result = (await builder.build(
    builder.environments.ssr,
  )) as RolldownOutput

  expect(result.output).not.toContainEqual(
    expect.objectContaining({
      type: 'asset',
      fileName: 'importmap.json',
    }),
  )
})

test('sharedConfigBuild and emitAssets', async () => {
  const root = resolve(dirname, 'fixtures/shared-config-build/emitAssets')
  const builder = await createBuilder({
    root,
    logLevel: 'warn',
    configFile: false,
    environments: {
      client: {
        build: {
          outDir: './dist/client',
          emitAssets: true,
          rolldownOptions: {
            input: '/entry.js',
          },
        },
      },
      ssr: {
        build: {
          outDir: './dist/ssr',
          emitAssets: true,
          rolldownOptions: {
            input: '/entry.js',
          },
        },
      },
      custom: {
        build: {
          outDir: './dist/custom',
          emitAssets: true,
          rolldownOptions: {
            input: '/entry.js',
          },
        },
      },
    },
    builder: {
      sharedConfigBuild: true,
    },
  })

  expect(
    ['client', 'ssr', 'custom'].map(
      (name) => builder.environments[name].config.build.emitAssets,
    ),
  ).toEqual([true, true, true])

  await builder.buildApp()

  expect(
    await Promise.all(
      ['client', 'ssr', 'custom'].map((name) =>
        fsp.readdir(
          resolve(
            root,
            builder.environments[name].config.build.outDir,
            'assets',
          ),
        ),
      ),
    ),
  ).toEqual([
    expect.arrayContaining([expect.stringMatching(/\.css$/)]),
    expect.arrayContaining([expect.stringMatching(/\.css$/)]),
    expect.arrayContaining([expect.stringMatching(/\.css$/)]),
  ])
})

test('resolving lib entry from the top-level input does not mutate the user config', async () => {
  const userLib: LibraryOptions = { formats: ['es'] }
  const config = await resolveConfig(
    {
      configFile: false,
      input: 'src/main.ts',
      build: { lib: userLib },
    },
    'build',
  )
  const resolvedLib = config.environments.client.build.lib
  assert(resolvedLib !== false)
  expect(resolvedLib.entry).toBe('src/main.ts')
  expect(userLib.entry).toBeUndefined()
})

describe('onRollupLog', () => {
  const pluginName = 'rollup-plugin-test'
  const msgInfo = 'This is the INFO message.'
  const msgWarn = 'This is the WARN message.'
  const buildProject = async (
    level: LogLevel | 'error',
    message: string | RollupLog,
    logger: Logger,
    options?: Pick<RolldownOptions, 'onLog' | 'onwarn'>,
  ) => {
    await build({
      root: resolve(dirname, 'packages/build-project'),
      logLevel: 'info',
      build: {
        write: false,
        rolldownOptions: {
          ...options,
          logLevel: 'debug',
        },
      },
      customLogger: logger,
      plugins: [
        {
          name: pluginName,
          resolveId(id) {
            this[level](message)
            if (id === 'entry.js') {
              return '\0' + id
            }
          },
          load(id) {
            if (id === '\0entry.js') {
              return `export default "This is test module";`
            }
          },
        },
      ],
    })
  }

  const callOnRollupLog = async (
    logger: Logger,
    level: LogLevel,
    log: RollupLog,
  ) => {
    const config = await resolveConfig(
      { customLogger: logger },
      'build',
      'production',
      'production',
    )
    const buildEnvironment = new BuildEnvironment('client', config)
    onRollupLog(level, log, buildEnvironment)
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('Rollup logs of info should be handled by vite', async () => {
    const logger = createLogger()
    const loggerSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})

    await buildProject('info', msgInfo, logger)
    const logs = loggerSpy.mock.calls.map((args) =>
      stripVTControlCharacters(args[0]),
    )
    expect(logs).contain(`[plugin ${pluginName}] ${msgInfo}`)
  })

  test('Rollup logs of warn should be handled by vite', async () => {
    const logger = createLogger('silent')
    const loggerSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await buildProject('warn', msgWarn, logger)
    const logs = loggerSpy.mock.calls.map((args) =>
      stripVTControlCharacters(args[0]),
    )
    expect(logs).contain(`[plugin ${pluginName}] ${msgWarn}`)
  })

  test('onLog passed by user is called', async () => {
    const logger = createLogger('silent')

    const onLogInfo = vi.fn((_log: RollupLog) => {})
    await buildProject('info', msgInfo, logger, {
      onLog(level, log) {
        if (level === 'info') {
          onLogInfo(log)
        }
      },
    })
    expect(onLogInfo).toBeCalledWith(
      expect.objectContaining({ message: msgInfo, plugin: pluginName }),
    )
  })

  test('onwarn passed by user is called', async () => {
    const logger = createLogger('silent')

    const onWarn = vi.fn((_log: RollupLog) => {})
    await buildProject('warn', msgWarn, logger, {
      onwarn(warning) {
        onWarn(warning)
      },
    })
    expect(onWarn).toBeCalledWith(
      expect.objectContaining({ message: msgWarn, plugin: pluginName }),
    )
  })

  test('should throw error when warning contains UNRESOLVED_IMPORT', async () => {
    const logger = createLogger()
    await expect(() =>
      callOnRollupLog(logger, 'warn', {
        code: 'UNRESOLVED_IMPORT',
        message: 'test',
      }),
    ).rejects.toThrowError(/Rolldown failed to resolve import/)
  })

  test.each([[`Unsupported expression`], [`statically analyzed`]])(
    'should ignore dynamic import warnings (%s)',
    async (message: string) => {
      const logger = createLogger()
      const loggerSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      await callOnRollupLog(logger, 'warn', {
        code: 'PLUGIN_WARNING',
        message: message,
        plugin: 'rollup-plugin-dynamic-import-variables',
      })
      expect(loggerSpy).toBeCalledTimes(0)
    },
  )

  test.each([[`CIRCULAR_DEPENDENCY`], [`THIS_IS_UNDEFINED`]])(
    'should ignore some warnings (%s)',
    async (code: string) => {
      const logger = createLogger()
      const loggerSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      await callOnRollupLog(logger, 'warn', {
        code: code,
        message: 'test message',
        plugin: pluginName,
      })
      expect(loggerSpy).toBeCalledTimes(0)
    },
  )
})

test('watch rebuild manifest', async (ctx) => {
  // this doesn't actually test watch rebuild
  // but it simulates something similar by running two builds for the same environment
  const root = resolve(dirname, 'fixtures/watch-rebuild-manifest')
  const builder = await createBuilder({
    root,
    logLevel: 'error',
    environments: {
      client: {
        build: {
          rolldownOptions: {
            input: '/entry.js',
          },
        },
      },
    },
    build: {
      manifest: true,
    },
  })

  function getManifestKeys(output: RolldownOutput) {
    return Object.keys(
      JSON.parse(
        (output.output.find((o) => o.fileName === '.vite/manifest.json') as any)
          .source,
      ),
    )
  }

  const result = await builder.build(builder.environments.client)
  expect(getManifestKeys(result as RolldownOutput)).toMatchInlineSnapshot(`
    [
      "dep.js",
      "entry.js",
    ]
  `)

  const entry = resolve(root, 'entry.js')
  const content = await fsp.readFile(entry, 'utf-8')
  await fsp.writeFile(
    entry,
    content.replace(`import('./dep.js')`, `'dep.js removed'`),
  )
  ctx.onTestFinished(async () => {
    await fsp.writeFile(entry, content)
  })

  const result2 = await builder.build(builder.environments.client)
  expect(getManifestKeys(result2 as RolldownOutput)).toMatchInlineSnapshot(`
    [
      "entry.js",
    ]
  `)
})

test('copies public directory after building same environment with write false first', async (ctx) => {
  const root = resolve(dirname, 'fixtures/public-dir-write-false')
  ctx.onTestFinished(() =>
    fsp.rm(resolve(root, 'dist'), { recursive: true, force: true }),
  )

  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: 'silent',
  })

  builder.environments.client.config.build.write = false
  await builder.build(builder.environments.client)

  builder.environments.client.config.build.write = true
  await builder.build(builder.environments.client)

  await expect(
    fsp.readFile(resolve(root, 'dist/favicon.svg'), 'utf-8'),
  ).resolves.toBe('<svg></svg>')
})

async function buildProjectWithRenderBuiltUrl(
  renderBuiltUrl: (filename: string) => string,
) {
  return (await build({
    root: resolve(dirname, 'packages/build-project'),
    logLevel: 'silent',
    build: {
      write: false,
      assetsInlineLimit: 0,
    },
    experimental: {
      renderBuiltUrl,
    },
    plugins: [
      {
        name: 'test',
        resolveId(id) {
          if (id === 'entry.js' || id === 'subentry.js') {
            return '\0' + id
          }
        },
        load(id) {
          if (id === '\0entry.js') {
            return `
              import assetUrl from '/asset.txt?url'
              console.log(assetUrl)
              window.addEventListener('click', () => { import('subentry.js') })
            `
          }
          if (id === '\0subentry.js') {
            return `export default 'subentry'`
          }
        },
      },
    ],
  })) as RolldownOutput
}

/**
 * for each chunks in output1, if there's a chunk in output2 with the same fileName,
 * ensure that the chunk code is the same. if not, the chunk hash should have changed.
 */
function assertOutputHashContentChange(
  output1: RolldownOutput,
  output2: RolldownOutput,
) {
  for (const chunk of output1.output) {
    if (chunk.type === 'chunk') {
      const chunk2 = output2.output.find(
        (c) => c.type === 'chunk' && c.fileName === chunk.fileName,
      ) as OutputChunk | undefined
      if (chunk2) {
        expect(
          chunk.code,
          `the ${chunk.fileName} chunk has the same hash but different contents between builds`,
        ).toEqual(chunk2.code)
      }
    }
  }
}

function getOutputHashChanges(
  output1: RolldownOutput,
  output2: RolldownOutput,
) {
  const map1 = Object.fromEntries(
    output1.output.map((o) => [o.name, o.fileName]),
  )
  const map2 = Object.fromEntries(
    output2.output.map((o) => [o.name, o.fileName]),
  )
  const names = Object.keys(map1).filter(Boolean)
  return {
    changed: names.filter((name) => map1[name] !== map2[name]),
    unchanged: names.filter((name) => map1[name] === map2[name]),
  }
}

describe('transactional publish', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(
      tempRoots
        .splice(0)
        .map((dir) => fsp.rm(dir, { recursive: true, force: true })),
    )
  })

  async function createTempProject(ssrVersion = 'v1'): Promise<string> {
    const root = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'vite-transactional-publish-'),
    )
    tempRoots.push(root)
    await fsp.mkdir(path.join(root, 'src'), { recursive: true })
    // the client output references the ssr output through the final
    // relative layout of the publish root
    await fsp.writeFile(
      path.join(root, 'src/client.js'),
      "console.log('../ssr/server.js')",
    )
    await writeSsrEntry(root, ssrVersion)
    return root
  }

  async function writeSsrEntry(root: string, version: string): Promise<void> {
    await fsp.writeFile(
      path.join(root, 'src/server.js'),
      `export function render() { return '${version}' }`,
    )
  }

  function baseConfig(
    root: string,
    overrides: {
      publishRoot?: string
      clientOutDir?: string
      ssrOutDir?: string
      plugins?: InlineConfig['plugins']
    } = {},
  ): InlineConfig {
    return {
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: overrides.plugins,
      environments: {
        client: {
          build: {
            outDir: overrides.clientOutDir ?? 'dist/client',
            manifest: true,
            rolldownOptions: {
              input: path.join(root, 'src/client.js'),
            },
          },
        },
        ssr: {
          build: {
            outDir: overrides.ssrOutDir ?? 'dist/ssr',
            ssr: true,
            rolldownOptions: {
              input: path.join(root, 'src/server.js'),
              output: { entryFileNames: '[name].js' },
            },
          },
        },
      },
      builder: {
        transactionalPublish: {
          publishRoot: overrides.publishRoot ?? 'dist',
        },
      },
    }
  }

  async function listSiblings(root: string): Promise<string[]> {
    return (await fsp.readdir(root)).filter(
      (name) =>
        name.startsWith('.vite-staging-') || name.endsWith('.vite-backup'),
    )
  }

  async function readAllFiles(
    dir: string,
  ): Promise<{ path: string; content: string }[]> {
    const files: { path: string; content: string }[] = []
    async function walk(current: string): Promise<void> {
      for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else {
          files.push({ path: full, content: await fsp.readFile(full, 'utf8') })
        }
      }
    }
    await walk(dir)
    return files
  }
  test('publishes client and ssr outputs only after every environment succeeds', async () => {
    const root = await createTempProject()
    const outDirsSeenByPlugins: Record<string, string> = {}
    const builder = await createBuilder(
      baseConfig(root, {
        plugins: [
          {
            name: 'capture-out-dir',
            buildStart() {
              outDirsSeenByPlugins[this.environment.name] =
                this.environment.config.build.outDir
            },
          },
        ],
      }),
    )
    await builder.buildApp()

    const dist = path.join(root, 'dist')
    // the ssr output is published at its final location
    const ssrEntry = path.join(dist, 'ssr/server.js')
    expect(fs.existsSync(ssrEntry)).toBe(true)
    // the client output references the ssr output and the link resolves
    // against the final publish tree
    const clientFiles = await readAllFiles(path.join(dist, 'client'))
    const clientEntry = clientFiles.find((file) => file.path.endsWith('.js'))!
    expect(clientEntry.content).toContain('../ssr/server.js')
    expect(
      fs.existsSync(path.resolve(dist, 'client', '../ssr/server.js')),
    ).toBe(true)
    // the manifest is published and no output references the staging tree
    const manifest = JSON.parse(
      await fsp.readFile(path.join(dist, 'client/.vite/manifest.json'), 'utf8'),
    )
    expect(Object.keys(manifest)).toContain('src/client.js')
    for (const file of await readAllFiles(dist)) {
      expect(file.content).not.toContain('.vite-staging-')
    }
    // plugins see the staging paths during the build, not the final paths
    expect(outDirsSeenByPlugins.client).toContain('.vite-staging-')
    expect(outDirsSeenByPlugins.ssr).toContain('.vite-staging-')
    // no staging or backup directories are left behind
    expect(await listSiblings(root)).toEqual([])

    // a second build replaces the published tree
    await writeSsrEntry(root, 'v2')
    const builder2 = await createBuilder(baseConfig(root))
    await builder2.buildApp()
    expect(await fsp.readFile(ssrEntry, 'utf8')).toContain('v2')
    expect(await listSiblings(root)).toEqual([])
  })

  test('keeps the previous publish tree when an environment fails to compile', async () => {
    const root = await createTempProject()
    await (await createBuilder(baseConfig(root))).buildApp()
    const dist = path.join(root, 'dist')
    const marker = path.join(dist, 'client/old.txt')
    await fsp.writeFile(marker, 'keep me')
    const oldSsrEntry = await fsp.readFile(
      path.join(dist, 'ssr/server.js'),
      'utf8',
    )

    // break the second environment
    await fsp.writeFile(path.join(root, 'src/server.js'), 'export {')
    const builder = await createBuilder(baseConfig(root))
    await expect(builder.buildApp()).rejects.toThrow()

    // the old publish tree is fully intact and no staging content remains
    expect(await fsp.readFile(marker, 'utf8')).toBe('keep me')
    expect(await fsp.readFile(path.join(dist, 'ssr/server.js'), 'utf8')).toBe(
      oldSsrEntry,
    )
    expect(await listSiblings(root)).toEqual([])
  })

  test('keeps the previous publish tree when a closeBundle hook fails', async () => {
    const root = await createTempProject()
    await (await createBuilder(baseConfig(root))).buildApp()
    const dist = path.join(root, 'dist')
    const marker = path.join(dist, 'client/old.txt')
    await fsp.writeFile(marker, 'keep me')

    const builder = await createBuilder(
      baseConfig(root, {
        plugins: [
          {
            name: 'fail-close-bundle',
            closeBundle() {
              if (this.environment.name === 'ssr') {
                throw new Error('closeBundle failed')
              }
            },
          },
        ],
      }),
    )
    await expect(builder.buildApp()).rejects.toThrow('closeBundle failed')

    expect(await fsp.readFile(marker, 'utf8')).toBe('keep me')
    expect(fs.existsSync(path.join(dist, 'ssr/server.js'))).toBe(true)
    expect(await listSiblings(root)).toEqual([])
  })
  test('restores the previous tree when the final rename fails', async () => {
    const root = await createTempProject()
    await (await createBuilder(baseConfig(root))).buildApp()
    const dist = path.join(root, 'dist')
    const marker = path.join(dist, 'client/old.txt')
    await fsp.writeFile(marker, 'keep me')
    await writeSsrEntry(root, 'v2')

    const originalRename = fs.promises.rename
    vi.spyOn(fs.promises, 'rename').mockImplementation(
      async (src: any, dest: any) => {
        if (String(src).includes('.vite-staging-')) {
          throw new Error('rename failed')
        }
        return originalRename.call(fs.promises, src, dest)
      },
    )

    const builder = await createBuilder(baseConfig(root))
    const error = await builder.buildApp().catch((e) => e)
    expect(error).toBeInstanceOf(TransactionalPublishError)
    expect(error.phase).toBe('publish')

    // the old tree was restored and no half-new output is served
    expect(await fsp.readFile(marker, 'utf8')).toBe('keep me')
    expect(
      await fsp.readFile(path.join(dist, 'ssr/server.js'), 'utf8'),
    ).toContain('v1')
    expect(await listSiblings(root)).toEqual([])
  })

  test('preserves the backup when restore fails and recovers on the next build', async () => {
    const root = await createTempProject()
    await (await createBuilder(baseConfig(root))).buildApp()
    const dist = path.join(root, 'dist')
    const backupDir = `${dist}.vite-backup`
    await writeSsrEntry(root, 'v2')

    const originalRename = fs.promises.rename
    vi.spyOn(fs.promises, 'rename').mockImplementation(
      async (src: any, dest: any) => {
        if (
          String(src).includes('.vite-staging-') ||
          String(src).endsWith('.vite-backup')
        ) {
          throw new Error('rename failed')
        }
        return originalRename.call(fs.promises, src, dest)
      },
    )

    const builder = await createBuilder(baseConfig(root))
    const error = await builder.buildApp().catch((e) => e)
    expect(error).toBeInstanceOf(TransactionalPublishError)
    expect(error.phase).toBe('restore')
    expect(error.message).toContain('restore')

    // the publish root is missing, but both the last published tree (backup)
    // and the complete new build (staging) are preserved for manual recovery
    expect(fs.existsSync(dist)).toBe(false)
    expect(
      await fsp.readFile(path.join(backupDir, 'ssr/server.js'), 'utf8'),
    ).toContain('v1')
    const stagingDirs = (await fsp.readdir(root)).filter((name) =>
      name.startsWith('.vite-staging-'),
    )
    expect(stagingDirs).toHaveLength(1)
    expect(
      await fsp.readFile(
        path.join(root, stagingDirs[0], 'ssr/server.js'),
        'utf8',
      ),
    ).toContain('v2')

    // the next build recovers the backup and publishes successfully
    vi.restoreAllMocks()
    const builder2 = await createBuilder(baseConfig(root))
    await builder2.buildApp()
    expect(
      await fsp.readFile(path.join(dist, 'ssr/server.js'), 'utf8'),
    ).toContain('v2')
    // the staging directory of the interrupted build is preserved until it
    // is removed manually
    expect(await listSiblings(root)).toEqual(stagingDirs)
    await fsp.rm(path.join(root, stagingDirs[0]), { recursive: true })
    expect(await listSiblings(root)).toEqual([])
  })

  test('rejects invalid publish roots and output directories', async () => {
    const root = await createTempProject()
    const expectInvalid = async (
      overrides: Parameters<typeof baseConfig>[1],
      pattern: RegExp,
    ) => {
      const builder = await createBuilder(baseConfig(root, overrides))
      await expect(builder.buildApp()).rejects.toThrow(pattern)
    }

    await expectInvalid({ publishRoot: '.' }, /project root/)
    await expectInvalid(
      { publishRoot: path.parse(root).root },
      /filesystem root/,
    )
    await expectInvalid(
      { clientOutDir: 'elsewhere/client' },
      /inside the publish root/,
    )
    await expectInvalid({ clientOutDir: 'dist' }, /inside the publish root/)
    await expectInvalid(
      { clientOutDir: 'dist/app', ssrOutDir: 'dist/app/ssr' },
      /must not overlap/,
    )
    expect(await listSiblings(root)).toEqual([])
  })

  test('rejects overlapping builds for the same publish root', async () => {
    const root = await createTempProject()
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((r) => (entered = r))
    const gate = new Promise<void>((r) => (release = r))
    const builder1 = await createBuilder(
      baseConfig(root, {
        plugins: [
          {
            name: 'gate',
            async buildStart() {
              entered()
              await gate
            },
          },
        ],
      }),
    )
    const builder2 = await createBuilder(baseConfig(root))

    const first = builder1.buildApp()
    await enteredPromise
    await expect(builder2.buildApp()).rejects.toThrow(
      /Overlapping transactional builds/,
    )
    release()
    await first

    // once the first build finishes, the publish root can be built again
    await builder2.buildApp()
    expect(fs.existsSync(path.join(root, 'dist/ssr/server.js'))).toBe(true)
    expect(await listSiblings(root)).toEqual([])
  })
})
