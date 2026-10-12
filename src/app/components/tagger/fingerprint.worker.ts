/// <reference lib="webworker" />
// Computes a Chromaprint fingerprint (the one AcoustID uses) from PCM audio,
// off the main thread. Chromaprint is compiled to WebAssembly; its .wasm
// is a separate file (LGPL: it can be swapped).
import createChromaprintModule from '@unimusic/chromaprint/dist/chromaprint.js'
import wasmUrl from '@unimusic/chromaprint/dist/chromaprint.wasm?url'

export interface FingerprintRequest {
  /** 16-bit samples, channels interleaved. */
  pcm: Int16Array
  sampleRate: number
  channels: number
}

export type FingerprintReply = { fingerprint: string } | { error: string }

// Chromaprint's default algorithm (TEST2), as fpcalc uses.
const ALGORITHM_DEFAULT = 1

let chromaprint: ReturnType<typeof createChromaprintModule> | null = null

self.onmessage = async (event: MessageEvent<FingerprintRequest>) => {
  const { pcm, sampleRate, channels } = event.data
  try {
    // Its own URL: the module can't find it next to itself once bundled.
    chromaprint ??= createChromaprintModule({ locateFile: () => wasmUrl })
    const m = await chromaprint
    const ctx = m._chromaprint_new(ALGORITHM_DEFAULT)
    if (!ctx) throw new Error('Chromaprint could not start')
    const data = m._malloc(pcm.length * 2)
    const out = m._malloc(4)
    try {
      m.HEAP16.set(pcm, data >> 1)
      const ok =
        m._chromaprint_start(ctx, sampleRate, channels) &&
        m._chromaprint_feed(ctx, data, pcm.length) &&
        m._chromaprint_finish(ctx) &&
        m._chromaprint_get_fingerprint(ctx, out)
      if (!ok) throw new Error('Chromaprint failed')
      const text = m.HEAP32[out >> 2]
      const fingerprint = m.UTF8ToString(text)
      m._free(text)
      self.postMessage({ fingerprint } satisfies FingerprintReply)
    } finally {
      m._free(data)
      m._free(out)
      m._chromaprint_free(ctx)
    }
  } catch (error) {
    self.postMessage({ error: String(error) } satisfies FingerprintReply)
  }
}
