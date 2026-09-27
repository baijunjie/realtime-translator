import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { asyncBufferFromFile, asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import {
  extractAudioBytes,
  FLEURS_SELECTION_ALGORITHM,
  FLEURS_SELECTION_SEED,
  FLEURS_JA_TEST,
  inspectWav,
  referenceText,
  selectDeterministicIndices,
  sha256,
  sourceUrl,
  verifyCorpusDirectory,
} from './fleurs-eval-lib.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const appDirectory = resolve(scriptDirectory, '..')
const defaultOutput = join(appDirectory, 'test-audio', 'eval', 'fleurs-ja-test')
const defaultCache = join(appDirectory, 'test-audio', 'cache', 'fleurs-ja-test.parquet')

function parseArguments(argv) {
  const options = { count: 100, output: defaultOutput, cache: defaultCache }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--count') options.count = Number(argv[++index])
    else if (argument === '--output') options.output = resolve(argv[++index])
    else if (argument === '--cache') options.cache = resolve(argv[++index])
    else if (argument === '--verify-only') options.verifyOnly = true
    else if (argument === '--help') options.help = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!Number.isInteger(options.count) || options.count < 1) {
    throw new Error('--count must be a positive integer')
  }
  return options
}

function printHelp() {
  console.log(`Download a deterministic Japanese FLEURS test subset for CER evaluation.

Usage: pnpm --filter @rt/macos fetch-eval-fleurs -- [options]

Options:
  --count <n>       Number of utterances (default: 100)
  --output <path>   Fixture directory (default: test-audio/eval/fleurs-ja-test)
  --cache <path>    Cached source Parquet file (default: test-audio/cache/...)
  --verify-only     Validate the local fixture set without network access
  --help            Show this help
`)
}

async function existingSize(path) {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

async function downloadWithResume(url, destination, expectedBytes) {
  await mkdir(dirname(destination), { recursive: true })
  let downloaded = await existingSize(destination)
  if (downloaded === expectedBytes) return
  if (downloaded > expectedBytes) {
    throw new Error(`Cached Parquet is larger than expected: ${destination}`)
  }

  const headers = downloaded > 0 ? { Range: `bytes=${downloaded}-` } : undefined
  const response = await fetch(url, { headers, redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`)
  }
  const appending = downloaded > 0 && response.status === 206
  if (!appending) downloaded = 0
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { flags: appending ? 'a' : 'w' }),
  )
  const finalSize = await existingSize(destination)
  if (finalSize !== expectedBytes) {
    throw new Error(`Incomplete Parquet download: expected ${expectedBytes}, got ${finalSize}`)
  }
}

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} failed (${signal ?? code})`))
    })
  })
}

async function writeAtomic(path, data) {
  const temporary = `${path}.partial`
  await writeFile(temporary, data)
  await rename(temporary, path)
}

async function writeAudio(path, sourcePath, bytes) {
  const format = inspectWav(bytes)
  if (format?.format === 1 && format.channels === 1 && format.sampleRate === 16000) {
    await writeAtomic(path, bytes)
    return format
  }

  const sourceExtension = extname(sourcePath) || '.audio'
  const temporary = `${path}.source${sourceExtension}`
  await writeFile(temporary, bytes)
  try {
    await run('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', temporary,
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', `${path}.partial`,
    ])
    await rename(`${path}.partial`, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return { format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16 }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) return printHelp()
  if (options.verifyOnly) {
    await verifyCorpusDirectory(options.output, options.count)
    console.log(`Verified ${options.count} existing FLEURS fixtures in ${options.output}`)
    return
  }
  try {
    await verifyCorpusDirectory(options.output, options.count)
    console.log(`Verified ${options.count} existing FLEURS fixtures in ${options.output}`)
    return
  } catch {
    if (await existingSize(options.output)) {
      throw new Error(`Output exists but is not the exact expected corpus: ${options.output}`)
    }
  }

  const url = sourceUrl()
  const remote = await asyncBufferFromUrl({ url })
  const remoteMetadata = await parquetMetadataAsync(remote)
  const total = Number(remoteMetadata.num_rows)
  if (total !== FLEURS_JA_TEST.totalRows) {
    throw new Error(`Pinned FLEURS split row count changed: expected ${FLEURS_JA_TEST.totalRows}, got ${total}`)
  }
  const selectedIndices = selectDeterministicIndices(total, options.count)
  const selected = new Set(selectedIndices)
  const stagingOutput = `${options.output}.partial-${process.pid}`

  console.log(`Downloading pinned FLEURS source (${(remote.byteLength / 1e6).toFixed(1)} MB)...`)
  await downloadWithResume(url, options.cache, remote.byteLength)
  {
    const file = await asyncBufferFromFile(options.cache)
    const rows = await parquetReadObjects({
      file,
      compressors,
      columns: ['id', 'path', 'transcription', 'raw_transcription', 'gender', 'language'],
    })
    const audioRows = await parquetReadObjects({
      file,
      compressors,
      columns: ['audio'],
      utf8: false,
    })
    if (audioRows.length !== rows.length) throw new Error('FLEURS audio and annotation row counts differ')
    await mkdir(stagingOutput, { recursive: true })
    const cases = []
    let ordinal = 0
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      if (!selected.has(rowIndex)) continue
      const row = rows[rowIndex]
      const reference = referenceText(row)
      const audio = extractAudioBytes(audioRows[rowIndex])
      const id = String(row.id)
      const name = `fleurs-ja-test-${String(++ordinal).padStart(3, '0')}-id-${id}`
      const wavPath = join(stagingOutput, `${name}.wav`)
      const audioFormat = await writeAudio(wavPath, row.path, audio)
      const wav = await readFile(wavPath)
      const audioSha256 = sha256(wav)
      await writeAtomic(join(stagingOutput, `${name}.txt`), `${reference}\n`)
      await writeAtomic(join(stagingOutput, `${name}.json`), `${JSON.stringify({
        lang: 'ja',
        source: {
          dataset: FLEURS_JA_TEST.dataset,
          config: FLEURS_JA_TEST.config,
          split: FLEURS_JA_TEST.split,
          revision: FLEURS_JA_TEST.revision,
          rowIndex,
          id,
          gender: Number(row.gender),
        },
      }, null, 2)}\n`)
      cases.push({ name, rowIndex, id, reference, normalizedReference: row.transcription, audioSha256, audioFormat })
    }
    if (cases.length !== options.count) {
      throw new Error(`Expected ${options.count} selected rows, wrote ${cases.length}`)
    }
    await writeAtomic(join(stagingOutput, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      source: { ...FLEURS_JA_TEST, url, totalRows: total },
      selection: { algorithm: FLEURS_SELECTION_ALGORITHM, seed: FLEURS_SELECTION_SEED, count: options.count },
      audio: { sampleRate: 16000, channels: 1, encoding: 'PCM WAV' },
      cases,
    }, null, 2)}\n`)
  }

  await verifyCorpusDirectory(stagingOutput, options.count)
  await mkdir(dirname(options.output), { recursive: true })
  await rename(stagingOutput, options.output)
  console.log(`Created and verified ${options.count} Japanese FLEURS fixtures in ${options.output}`)
}

await main()
