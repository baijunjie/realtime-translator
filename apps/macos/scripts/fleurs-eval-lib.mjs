import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const FLEURS_SELECTION_ALGORITHM = 'seeded-xorshift32-shuffle'
export const FLEURS_SELECTION_SEED = 0x464c4555

export const FLEURS_JA_TEST = Object.freeze({
  dataset: 'google/fleurs',
  config: 'ja_jp',
  split: 'test',
  revision: '8d6448449ef85cacf10301f85c215be519e08061',
  license: 'CC-BY-4.0',
  attribution: 'FLEURS dataset, Google LLC',
  parquet: 'ja_jp/test-00000-of-00001.parquet',
  totalRows: 650,
})

export function sourceUrl(source = FLEURS_JA_TEST) {
  return `https://huggingface.co/datasets/${source.dataset}/resolve/${source.revision}/${source.parquet}`
}

export function selectDeterministicIndices(total, count, seed = 0x464c4555) {
  if (!Number.isInteger(total) || total < 1) throw new Error('total must be a positive integer')
  if (!Number.isInteger(count) || count < 1 || count > total) {
    throw new Error(`count must be an integer between 1 and ${total}`)
  }

  const indices = Array.from({ length: total }, (_, index) => index)
  let state = seed >>> 0
  for (let index = total - 1; index > 0; index -= 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    const swapIndex = (state >>> 0) % (index + 1)
    ;[indices[index], indices[swapIndex]] = [indices[swapIndex], indices[index]]
  }
  return indices.slice(0, count).sort((left, right) => left - right)
}

export function inspectWav(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (offset, length) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length))
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return null

  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const chunk = ascii(offset, 4)
    const size = view.getUint32(offset + 4, true)
    if (chunk === 'fmt ' && size >= 16 && offset + 8 + size <= bytes.byteLength) {
      return {
        format: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      }
    }
    offset += 8 + size + (size % 2)
  }
  return null
}

export function extractAudioBytes(row) {
  const bytes = row?.audio?.bytes
  if (bytes instanceof Uint8Array) return bytes
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  throw new Error('FLEURS row does not contain audio.bytes')
}

export function referenceText(row) {
  const text = typeof row?.raw_transcription === 'string' ? row.raw_transcription.trim() : ''
  if (!text) throw new Error('FLEURS row does not contain raw_transcription')
  return text
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function verifyCorpusDirectory(output, count) {
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  const source = manifest.source ?? {}
  if (
    source.dataset !== FLEURS_JA_TEST.dataset ||
    source.config !== FLEURS_JA_TEST.config ||
    source.split !== FLEURS_JA_TEST.split ||
    source.revision !== FLEURS_JA_TEST.revision ||
    source.totalRows !== FLEURS_JA_TEST.totalRows
  ) {
    throw new Error('Corpus manifest source does not match the pinned FLEURS split')
  }
  if (
    manifest.selection?.algorithm !== FLEURS_SELECTION_ALGORITHM ||
    manifest.selection?.seed !== FLEURS_SELECTION_SEED ||
    manifest.selection?.count !== count ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length !== count
  ) {
    throw new Error('Corpus manifest selection does not match the configured deterministic sample')
  }

  const expectedIndices = selectDeterministicIndices(FLEURS_JA_TEST.totalRows, count)
  const actualIndices = manifest.cases.map((item) => item.rowIndex)
  if (actualIndices.some((value, index) => value !== expectedIndices[index])) {
    throw new Error('Corpus manifest row indices do not match the deterministic sample')
  }

  const expectedFiles = new Set(['manifest.json'])
  for (const item of manifest.cases) {
    expectedFiles.add(`${item.name}.wav`)
    expectedFiles.add(`${item.name}.txt`)
    expectedFiles.add(`${item.name}.json`)
  }
  const entries = await readdir(output, { withFileTypes: true })
  if (
    entries.length !== expectedFiles.size ||
    entries.some((entry) => !entry.isFile() || !expectedFiles.has(entry.name))
  ) {
    throw new Error('Corpus directory contains missing or unexpected files')
  }

  const names = new Set()
  for (let index = 0; index < manifest.cases.length; index += 1) {
    const item = manifest.cases[index]
    const expectedName = `fleurs-ja-test-${String(index + 1).padStart(3, '0')}-id-${item.id}`
    if (item.name !== expectedName || names.has(item.name)) {
      throw new Error('Corpus manifest contains an invalid or duplicate case name')
    }
    names.add(item.name)
    const wav = await readFile(join(output, `${item.name}.wav`))
    const text = (await readFile(join(output, `${item.name}.txt`), 'utf8')).trim()
    const metadata = JSON.parse(await readFile(join(output, `${item.name}.json`), 'utf8'))
    const format = inspectWav(wav)
    if (sha256(wav) !== item.audioSha256 || text !== item.reference) {
      throw new Error(`Corpus case content does not match manifest: ${item.name}`)
    }
    if (
      format?.format !== 1 ||
      format.channels !== 1 ||
      format.sampleRate !== 16000 ||
      format.bitsPerSample !== 16
    ) {
      throw new Error(`Corpus audio is not 16 kHz mono PCM16 WAV: ${item.name}`)
    }
    if (
      metadata.lang !== 'ja' ||
      metadata.source?.dataset !== FLEURS_JA_TEST.dataset ||
      metadata.source?.config !== FLEURS_JA_TEST.config ||
      metadata.source?.split !== FLEURS_JA_TEST.split ||
      metadata.source?.revision !== FLEURS_JA_TEST.revision ||
      metadata.source?.rowIndex !== item.rowIndex ||
      String(metadata.source?.id) !== String(item.id)
    ) {
      throw new Error(`Corpus case metadata does not match manifest: ${item.name}`)
    }
  }
  return manifest
}
