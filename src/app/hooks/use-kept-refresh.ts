import { useEffect } from 'react'
import { refreshKeptItem } from '@/service/song-cache/kept'
import { KeptKind } from '@/store/song-cache.store'

/** A kept album, artist or playlist checks the server when it's opened. */
export function useKeptRefresh(kind: KeptKind, id: string | undefined) {
  useEffect(() => {
    if (id) refreshKeptItem(kind, id)
  }, [kind, id])
}
