const buildId = (new URL(self.location.href).searchParams.get('build') || 'dev').replace(/[^a-zA-Z0-9_-]/g, '')
const scope = new URL('.', self.location.href).pathname
const assetsPath = `${scope}assets/`
const cachePrefix = scope === '/' ? 'crate-shell-' : `crate-shell:${scope}:`
const CACHE = `${cachePrefix}${buildId}`

function isHtml(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/html')
}

function validAsset(path, response) {
  if (!response.ok || isHtml(response)) return false
  const type = (response.headers.get('content-type') || '').toLowerCase()
  if (/\.m?js$/.test(path)) return /javascript|ecmascript/.test(type)
  if (/\.css$/.test(path)) return type.includes('text/css')
  return !!type
}

function htmlHasBuild(html) {
  const escaped = buildId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`<meta\\s+name=["']crate-build-id["']\\s+content=["']${escaped}["']`).test(html)
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    try {
      const page = await fetch(scope, { cache: 'no-store' })
      if (!page.ok || !isHtml(page)) throw new Error('shell document unavailable')
      const html = await page.clone().text()
      if (!htmlHasBuild(html)) throw new Error('shell build identity mismatch')
      const references = [...html.matchAll(/(?:src|href)="([^"?#]+)"/g)]
      const assets = [...new Set(references.map(match => match[1]).filter(path => path.startsWith(assetsPath)))]
      if (!assets.some(path => /\.m?js$/.test(path)) || !assets.some(path => /\.css$/.test(path))) throw new Error('required shell assets missing')
      const responses = await Promise.all(assets.map(async path => {
        const response = await fetch(path, { cache: 'no-store' })
        if (!validAsset(path, response)) throw new Error('shell asset unavailable or has the wrong content type')
        return [path, response]
      }))
      for (const [path, response] of responses) await cache.put(path, response)
      await cache.put(scope, page)
      await self.skipWaiting()
    } catch (error) {
      await caches.delete(CACHE)
      throw error
    }
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(cachePrefix) && key !== CACHE).map(key => caches.delete(key)),
  )).then(() => self.clients.claim()))
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(scope)) return
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        if (response.ok && isHtml(response)) {
          try {
            const html = await response.clone().text()
            if (htmlHasBuild(html)) await (await caches.open(CACHE)).put(scope, response.clone())
          } catch { /* Keep the network navigation usable if validation or caching fails. */ }
        }
        return response
      } catch {
        const fallback = await (await caches.open(CACHE)).match(scope)
        return fallback ?? new Response('Crate is offline and its app shell is not available yet.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
    })())
    return
  }
  if (url.pathname.startsWith(assetsPath)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(request)
      if (cached) return cached
      try {
        const response = await fetch(request)
        if (!validAsset(url.pathname, response)) return new Response('Crate app asset response was invalid.', { status: 502 })
        try { await cache.put(request, response.clone()) } catch { /* Return valid network code if storage is unavailable. */ }
        return response
      } catch { return new Response('Crate app asset is unavailable offline.', { status: 503 }) }
    })())
  }
})
