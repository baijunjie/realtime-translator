import assert from 'node:assert/strict'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractAudioBytes,
  FLEURS_JA_TEST,
  FLEURS_SELECTION_ALGORITHM,
  FLEURS_SELECTION_SEED,
  inspectWav,
  referenceText,
  selectDeterministicIndices,
  sha256,
  sourceUrl,
  verifyCorpusDirectory,
} from './fleurs-eval-lib.mjs'

function wavBytes(format = 1) {
  const bytes = new Uint8Array(44)
  const view = new DataView(bytes.buffer)
  bytes.set(Buffer.from('RIFF'), 0)
  view.setUint32(4, 36, true)
  bytes.set(Buffer.from('WAVEfmt '), 8)
  view.setUint32(16, 16, true)
  view.setUint16(20, format, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  bytes.set(Buffer.from('data'), 36)
  return bytes
}

async function writeFixture(directory, audio = wavBytes()) {
  const rowIndex = selectDeterministicIndices(FLEURS_JA_TEST.totalRows, 1)[0]
  const id = 'fixture'
  const name = `fleurs-ja-test-001-id-${id}`
  const reference = '日本語です。'
  await writeFile(join(directory, `${name}.wav`), audio)
  await writeFile(join(directory, `${name}.txt`), `${reference}\n`)
  await writeFile(join(directory, `${name}.json`), JSON.stringify({
    lang: 'ja',
    source: { ...FLEURS_JA_TEST, rowIndex, id },
  }))
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    source: FLEURS_JA_TEST,
    selection: { algorithm: FLEURS_SELECTION_ALGORITHM, seed: FLEURS_SELECTION_SEED, count: 1 },
    cases: [{ name, rowIndex, id, reference, audioSha256: sha256(audio) }],
  }))
  return name
}

test('selectDeterministicIndices returns a stable, unique, sorted sample', () => {
  const first = selectDeterministicIndices(650, 100)
  const second = selectDeterministicIndices(650, 100)
  assert.deepEqual(first, second)
  assert.equal(first.length, 100)
  assert.equal(new Set(first).size, 100)
  assert.ok(first.every((index, position) => position === 0 || first[position - 1] < index))
  assert.ok(first[0] >= 0 && first.at(-1) < 650)
  assert.deepEqual(first.slice(0, 10), [1, 6, 15, 19, 28, 37, 40, 54, 57, 59])
  assert.deepEqual(first.slice(-10), [549, 553, 566, 581, 585, 587, 592, 594, 618, 621])
})

test('sourceUrl pins the corpus revision', () => {
  assert.match(sourceUrl(), /resolve\/[0-9a-f]{40}\/ja_jp\/test-/)
})

test('inspectWav reads the format chunk even when it is not at a fixed offset', () => {
  const bytes = new Uint8Array(58)
  const view = new DataView(bytes.buffer)
  bytes.set(Buffer.from('RIFF'), 0)
  bytes.set(Buffer.from('WAVE'), 8)
  bytes.set(Buffer.from('JUNK'), 12)
  view.setUint32(16, 2, true)
  bytes.set(Buffer.from('fmt '), 22)
  view.setUint32(26, 16, true)
  view.setUint16(30, 1, true)
  view.setUint16(32, 1, true)
  view.setUint32(34, 16000, true)
  view.setUint16(44, 16, true)
  assert.deepEqual(inspectWav(bytes), {
    format: 1,
    channels: 1,
    sampleRate: 16000,
    bitsPerSample: 16,
  })
})

test('row helpers reject missing annotations and audio', () => {
  const bytes = new Uint8Array([1, 2, 3])
  assert.equal(extractAudioBytes({ audio: { bytes } }), bytes)
  assert.equal(referenceText({ raw_transcription: ' 日本語です。 ' }), '日本語です。')
  assert.throws(() => extractAudioBytes({}), /audio\.bytes/)
  assert.throws(() => referenceText({ raw_transcription: ' ' }), /raw_transcription/)
})

test('verifyCorpusDirectory rejects missing, extra, and non-PCM fixture files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rt-fleurs-test-'))
  try {
    const name = await writeFixture(directory)
    await verifyCorpusDirectory(directory, 1)

    await writeFile(join(directory, 'unexpected.wav'), wavBytes())
    await assert.rejects(verifyCorpusDirectory(directory, 1), /missing or unexpected/)
    await unlink(join(directory, 'unexpected.wav'))

    await unlink(join(directory, `${name}.txt`))
    await assert.rejects(verifyCorpusDirectory(directory, 1), /missing or unexpected/)
    await writeFile(join(directory, `${name}.txt`), '日本語です。\n')

    await writeFixture(directory, wavBytes(3))
    await assert.rejects(verifyCorpusDirectory(directory, 1), /not 16 kHz mono PCM16/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
