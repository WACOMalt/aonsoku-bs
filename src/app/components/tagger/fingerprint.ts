import { getSongStreamUrl } from '@/api/httpClient'
import { TaggerError } from '@/service/tagger'
import { ISong } from '@/types/responses/song'
import type { FingerprintReply, FingerprintRequest } from './fingerprint.worker'

// Chromaprint, like fpcalc, listens to the first two minutes.
const SECONDS = 120
// The song comes as a 128 kbps MP3: a little over two minutes.
const MP3_BYTES = 2.5 * 1024 * 1024
// When the server can't convert, the original file (read whole).
const MAX_ORIGINAL_BYTES = 80 * 1024 * 1024

/**
 * The song's Chromaprint fingerprint and its length in seconds, for
 * AcoustID. The audio is downloaded and decoded here, never played.
 */
export async function fingerprintSong(
  song: ISong,
  signal?: AbortSignal,
): Promise<{ fingerprint: string; duration: number }> {
  try {
    const { fingerprint, duration } = await fingerprintAudio(
      await download(song, signal),
    )
    return { fingerprint, duration: Math.round(song.duration || duration) }
  } catch (error) {
    if (error instanceof TaggerError || signal?.aborted) throw error
    throw new TaggerError('FINGERPRINT_FAILED')
  }
}

/** The fingerprint of encoded audio (any format the browser decodes). */
export async function fingerprintAudio(data: ArrayBuffer) {
  const audio = await decode(data)
  const fingerprint = await chromaprint(toPcm(audio))
  return { fingerprint, duration: audio.duration }
}

async function download(song: ISong, signal?: AbortSignal) {
  const res = await fetch(getSongStreamUrl(song.id, '128', 'mp3'), { signal })
  if (!res.ok || !res.body) throw new TaggerError('FINGERPRINT_FAILED')
  const converted = (res.headers.get('content-type') ?? '').includes('mpeg')
  const limit = converted ? MP3_BYTES : MAX_ORIGINAL_BYTES
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < limit) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch (error) {
      // A converted stream can end before the length the server guessed
      // for it: what came is the song.
      if (size > 0 && !signal?.aborted) break
      throw error
    }
    if (chunk.done) break
    chunks.push(chunk.value)
    size += chunk.value.length
  }
  await reader.cancel().catch(() => {})
  if (!converted && size >= limit) throw new TaggerError('FINGERPRINT_FAILED')
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes.buffer
}

async function decode(data: ArrayBuffer): Promise<AudioBuffer> {
  // An offline context decodes without touching the audio output.
  const context = new OfflineAudioContext(1, 1, 44100)
  try {
    return await context.decodeAudioData(data)
  } catch {
    throw new TaggerError('FINGERPRINT_FAILED')
  }
}

/** The first two minutes, 16-bit, at most two channels interleaved. */
function toPcm(audio: AudioBuffer): FingerprintRequest {
  const channels = Math.min(audio.numberOfChannels, 2)
  const frames = Math.min(audio.length, SECONDS * audio.sampleRate)
  const pcm = new Int16Array(frames * channels)
  for (let c = 0; c < channels; c++) {
    const data = audio.getChannelData(c)
    for (let i = 0; i < frames; i++) {
      // The exact inverse of decoding 16-bit audio (÷ 32768).
      const s = Math.round(data[i] * 32768)
      pcm[i * channels + c] = Math.max(-32768, Math.min(32767, s))
    }
  }
  return { pcm, sampleRate: audio.sampleRate, channels }
}

function chromaprint(request: FingerprintRequest): Promise<string> {
  const worker = new Worker(
    new URL('./fingerprint.worker.ts', import.meta.url),
    { type: 'module' },
  )
  return new Promise<string>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<FingerprintReply>) => {
      const reply = event.data
      if ('fingerprint' in reply && reply.fingerprint)
        resolve(reply.fingerprint)
      else reject(new TaggerError('FINGERPRINT_FAILED'))
    }
    worker.onerror = () => reject(new TaggerError('FINGERPRINT_FAILED'))
    worker.postMessage(request, [request.pcm.buffer])
  }).finally(() => worker.terminate())
}
