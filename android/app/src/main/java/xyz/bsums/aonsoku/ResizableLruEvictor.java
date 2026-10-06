package xyz.bsums.aonsoku;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.cache.Cache;
import androidx.media3.datasource.cache.CacheEvictor;
import androidx.media3.datasource.cache.CacheSpan;

import java.util.TreeSet;

/**
 * Removes the songs played longest ago once the cache is over its size,
 * like Media3's LeastRecentlyUsedCacheEvictor, except that the size can
 * change while the cache is open (Settings → Caches).
 */
@OptIn(markerClass = UnstableApi.class)
final class ResizableLruEvictor implements CacheEvictor {

    private final TreeSet<CacheSpan> leastRecentlyUsed =
        new TreeSet<>(ResizableLruEvictor::compare);
    private long maxBytes;
    private long currentSize;

    ResizableLruEvictor(long maxBytes) {
        this.maxBytes = maxBytes;
    }

    /** Sets the size and removes what no longer fits. */
    void setMaxBytes(Cache cache, long bytes) {
        // SimpleCache calls the evictor while holding its own lock.
        synchronized (cache) {
            maxBytes = bytes;
            evict(cache, 0);
        }
    }

    @Override
    public boolean requiresCacheSpanTouches() {
        return true;
    }

    @Override
    public void onCacheInitialized() {}

    @Override
    public void onStartFile(Cache cache, String key, long position, long length) {
        if (length != C.LENGTH_UNSET) evict(cache, length);
    }

    @Override
    public void onSpanAdded(Cache cache, CacheSpan span) {
        leastRecentlyUsed.add(span);
        currentSize += span.length;
        evict(cache, 0);
    }

    @Override
    public void onSpanRemoved(Cache cache, CacheSpan span) {
        leastRecentlyUsed.remove(span);
        currentSize -= span.length;
    }

    @Override
    public void onSpanTouched(Cache cache, CacheSpan oldSpan, CacheSpan newSpan) {
        onSpanRemoved(cache, oldSpan);
        onSpanAdded(cache, newSpan);
    }

    private void evict(Cache cache, long requiredSpace) {
        while (currentSize + requiredSpace > maxBytes && !leastRecentlyUsed.isEmpty()) {
            cache.removeSpan(leastRecentlyUsed.first());
        }
    }

    private static int compare(CacheSpan a, CacheSpan b) {
        long difference = a.lastTouchTimestamp - b.lastTouchTimestamp;
        if (difference == 0) return a.compareTo(b);
        return a.lastTouchTimestamp < b.lastTouchTimestamp ? -1 : 1;
    }
}
