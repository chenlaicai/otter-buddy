import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFileSync } from 'fs'
import { resolve, join } from 'path'

const app = new Hono()
const distPath = resolve(import.meta.dirname, 'dist')

// Serve static assets (JS, CSS, images)
app.use('/assets/*', serveStatic({ root: distPath }))

// MPA routes - each page serves its own HTML file
const pages = ['/', '/memory', '/skills', '/settings'] as const

for (const path of pages) {
  const fileName = path === '/' ? 'index.html' : `${path.slice(1)}.html`
  const filePath = join(distPath, fileName)

  app.get(path, c => {
    try {
      const html = readFileSync(filePath, 'utf-8')
      return c.html(html)
    } catch {
      return c.text('Not found', 404)
    }
  })
}

// Conversation SPA fallback (handles /conversation/:id)
app.get('/conversation/:id', c => {
  try {
    const html = readFileSync(join(distPath, 'index.html'), 'utf-8')
    return c.html(html)
  } catch {
    return c.text('Not found', 404)
  }
})

// TODO: WebSocket endpoint for real-time conversation streaming
// app.get('/ws', upgradeWebSocket(c => ({ ... })))

const port = Number(process.env.PORT) || 3000

serve({ fetch: app.fetch, port }, info => {
  console.log(`Otter Buddy web server running at http://localhost:${info.port}`)
})
