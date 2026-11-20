// The local relay the guarded provider routes point at.
//
// One listener, one prefix per vendor target. Its jobs: be the only path to the
// vendor so a request can be refused before a single upstream byte is written,
// shape bursts, and present one deterministic client fingerprint per request
// instead of whatever the SDK and host happen to leak.
import http from 'node:http'
import zlib from 'node:zlib'
import { applySettings, currentSettings, renderPanel } from './panel.js'
import { classifyUpstreamError } from './risk.js'
import { createTunneledRequest } from './transport.js'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function writeJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

function buildUpstreamHeaders(target, incoming) {
  const headers = {
    host: target.upstreamHost,
    'user-agent': target.headers.userAgent,
    'accept-language': target.headers.acceptLanguage,
    'accept-encoding': 'identity',
    connection: 'close',
  }
  if (target.headers.apiClientHeader && target.headers.apiClient) {
    headers[target.headers.apiClientHeader] = target.headers.apiClient
  }
  for (const name of ['content-type', 'accept', 'authorization', ...target.headers.forwardHeaders]) {
    const value = incoming[name]
    if (typeof value === 'string' && value !== '') headers[name] = value
  }
  return headers
}

function writeGuardRejection(cfg, target, res, admission) {
  // 403/PERMISSION_DENIED is deliberate over 5xx: the harness retry policy
  // retries SERVER-class failures, and retrying a locally blocked request only
  // produces noise. A 4xx ends the step after one attempt.
  writeJson(
    res,
    403,
    {
      error: {
        code: 403,
        message: `[dsh-gemini-guard] 本地拦截（${target.displayName}）：${admission.detail || admission.reason}。`
          + ` 请求未发送到厂商。复检：${cfg.controlBaseUrl}/recheck`,
        status: 'PERMISSION_DENIED',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'GEMINI_GUARD_BLOCKED',
          domain: 'dsh-gemini-guard.local',
          metadata: { target: target.id, guard_reason: String(admission.reason) },
        }],
      },
    },
    { 'x-gemini-guard': `blocked-${admission.reason}` },
  )
}

function decodeBody(response) {
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase()
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return { stream: response.pipe(zlib.createGunzip()), decoded: true }
    case 'deflate':
      return { stream: response.pipe(zlib.createInflate()), decoded: true }
    case 'br':
      return { stream: response.pipe(zlib.createBrotliDecompress()), decoded: true }
    default:
      return { stream: response, decoded: false }
  }
}

function isStreamingRequest(requestPath, contentType) {
  return /streamGenerateContent|alt=sse|stream=true|:stream/i.test(requestPath)
    || String(contentType ?? '').includes('text/event-stream')
}

/** Vendors close an SSE turn with different markers; any of them means "done". */
function sawTerminator(text) {
  return text.includes('[DONE]')
    || text.includes('"finishReason"')
    || text.includes('finish_reason')
    || text.includes('message_stop')
    || text.includes('response.completed')
}

/** Counting semaphore: bursts queue instead of being rejected or amplified. */
function createSemaphore(max) {
  let active = 0
  const waiters = []
  return {
    get active() {
      return active
    },
    acquire(timeoutMs) {
      if (active < max) {
        active += 1
        return Promise.resolve({ release: () => this.release() })
      }
      return new Promise((resolve, reject) => {
        const waiter = () => {
          clearTimeout(timer)
          resolve({ release: () => this.release() })
        }
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`并发排队超时（${timeoutMs} ms）`))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    release() {
      const next = waiters.shift()
      if (next) next()
      else active = Math.max(0, active - 1)
    },
  }
}

export function createRelayServer({ cfg, guard, log, persist, unroute, route, integrity }) {
  const semaphores = new Map()
  const server = http.createServer((req, res) => {
    void handle(req, res)
  })
  server.on('clientError', (error, socket) => {
    log.warn('relay 客户端连接错误', error.message)
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  const relayTargets = () => cfg.enabledTargets.filter((target) => target.transport === 'relay')
  const netFor = () => {
    const first = relayTargets()[0] ?? Object.values(cfg.targets)[0]
    return {
      proxy: cfg.egress.proxy,
      connectTimeoutMs: cfg.connectTimeoutMs,
      tlsTimeoutMs: cfg.tlsTimeoutMs,
      userAgent: first?.headers.userAgent ?? 'dsh-gemini-guard',
      acceptLanguage: first?.headers.acceptLanguage ?? 'en-US,en;q=0.9',
    }
  }
  const semaphoreFor = (targetId) => {
    let semaphore = semaphores.get(targetId)
    if (!semaphore) {
      semaphore = createSemaphore(cfg.limits.maxConcurrentPerTarget)
      semaphores.set(targetId, semaphore)
    }
    return semaphore
  }

  function matchTarget(url) {
    let best = null
    for (const target of relayTargets()) {
      if (url === target.pathPrefix || url.startsWith(`${target.pathPrefix}/`) || url.startsWith(`${target.pathPrefix}?`)) {
        if (!best || target.pathPrefix.length > best.pathPrefix.length) best = target
      }
    }
    return best
  }

  async function handle(req, res) {
    const url = req.url ?? '/'

    if (url.startsWith('/_gemini-guard')) {
      await handleControl(req, res, url)
      return
    }

    const target = matchTarget(url)
    if (!target) {
      writeJson(res, 404, {
        error: { code: 404, message: `未知路径 ${url}`, prefixes: relayTargets().map((entry) => entry.pathPrefix) },
      })
      return
    }

    const admission = await guard.admit(target.id)
    if (!admission.ok) {
      log.warn('拦截请求', `${target.id} ${req.method} ${url} -> ${admission.reason}`)
      // Drain any body so the client reads our 403 instead of a reset.
      req.resume()
      writeGuardRejection(cfg, target, res, admission)
      return
    }

    const requestPath = url.slice(target.pathPrefix.length) || '/'
    await forward(target, req, res, requestPath)
  }

  async function handleControl(req, res, url) {
    const [pathPart, queryPart = ''] = url.split('?')
    const query = new URLSearchParams(queryPart)
    const targetId = query.get('target')

    if (pathPart === '/_gemini-guard' || pathPart === '/_gemini-guard/' || pathPart === '/_gemini-guard/panel') {
      const html = renderPanel()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    if (pathPart === '/_gemini-guard/status') {
      writeJson(res, 200, guard.snapshot())
      return
    }
    if (pathPart === '/_gemini-guard/settings') {
      if (req.method === 'POST') {
        const body = await readBody(req, 65536)
        let patch = null
        try {
          patch = JSON.parse(body)
        } catch {
          writeJson(res, 400, { error: { code: 400, message: '请求体不是合法 JSON' } })
          return
        }
        const applied = applySettings(cfg, patch, guard)
        let persisted = false
        let persistError = ''
        if (typeof persist === 'function') {
          try {
            await persist(patch)
            persisted = true
          } catch (error) {
            persistError = error instanceof Error ? error.message : String(error)
          }
        } else {
          persistError = '当前没有可写的配置入口'
        }
        log.info('控制面板更新开关', applied.join(','))
        writeJson(res, 200, { applied, persisted, persistError, settings: currentSettings(cfg) })
        return
      }
      writeJson(res, 200, currentSettings(cfg))
      return
    }
    if (pathPart === '/_gemini-guard/route') {
      if (typeof route !== 'function') {
        writeJson(res, 503, { ok: false, error: 'route 不可用' })
        return
      }
      try {
        const result = await route()
        writeJson(res, result.ok ? 200 : 500, result)
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (pathPart === '/_gemini-guard/unroute') {
      if (typeof unroute !== 'function') {
        writeJson(res, 503, { ok: false, error: 'unroute 不可用（缺少 configEditor）' })
        return
      }
      try {
        const restored = await unroute()
        writeJson(res, 200, { ok: true, restored })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (pathPart === '/_gemini-guard/recheck') {
      const ids = targetId ? [targetId] : relayTargets().map((target) => target.id)
      const results = {}
      for (const id of ids) results[id] = await guard.probe(id, { force: true })
      const ok = Object.values(results).every((result) => result.ok)
      writeJson(res, ok ? 200 : 503, { ok, results })
      return
    }
    if (pathPart === '/_gemini-guard/reset') {
      const result = await guard.reset(targetId ?? undefined)
      writeJson(res, result.ok ? 200 : 503, { ok: result.ok, result })
      return
    }
    if (pathPart === '/_gemini-guard/diff') {
      // 三份代码 diff：工作区 ↔ GitHub ↔ 已安装副本。默认比本插件自己。
      if (!integrity) {
        writeJson(res, 503, { ok: false, error: 'diff 不可用' })
        return
      }
      try {
        const report = await integrity.check(targetId || 'dsh-gemini-guard', {
          repo: query.get('repo') ?? '',
          ref: query.get('ref') ?? '',
          refresh: query.get('refresh') === '1' || req.method === 'POST',
        })
        writeJson(res, 200, report)
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    writeJson(res, 404, { error: { code: 404, message: `未知控制端点 ${pathPart}` } })
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let bytes = 0
      req.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > limit) {
          req.destroy()
          reject(new Error('请求体过大'))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  async function forward(target, req, res, requestPath) {
    const chunks = []
    let bytes = 0
    let tooLarge = false

    req.on('data', (chunk) => {
      if (tooLarge) return
      bytes += chunk.length
      if (bytes > cfg.maxRequestBytes) {
        tooLarge = true
        chunks.length = 0
        writeJson(res, 413, { error: { code: 413, message: `请求体超过 ${cfg.maxRequestBytes} 字节上限` } })
        req.resume()
        return
      }
      chunks.push(chunk)
    })

    req.on('error', (error) => log.warn('读取客户端请求失败', error.message))
    req.on('end', () => {
      if (tooLarge || res.writableEnded) return
      void dispatch(Buffer.concat(chunks))
    })

    async function dispatch(body) {
      let slot = { release() {} }
      if (cfg.features.burstLimit) {
        try {
          slot = await semaphoreFor(target.id).acquire(cfg.limits.queueTimeoutMs)
        } catch (error) {
          writeJson(res, 503, {
            error: { code: 503, message: `[dsh-gemini-guard] ${error.message}`, status: 'UNAVAILABLE' },
          }, { 'x-gemini-guard': 'throttled' })
          return
        }
      }

      let upstreamRequest
      try {
        upstreamRequest = await createTunneledRequest(netFor(), {
          host: target.upstreamHost,
          port: target.upstreamPort,
          method: req.method ?? 'POST',
          path: requestPath,
          headers: buildUpstreamHeaders(target, req.headers),
        })
      } catch (error) {
        slot.release()
        guard.recordOutcome(target.id, { kind: 'transport', detail: `建立出口连接失败：${error.message}` })
        writeJson(res, 502, {
          error: { code: 502, message: `[dsh-gemini-guard] 无法建立到 ${target.upstreamHost} 的出口连接：${error.message}`, status: 'UNAVAILABLE' },
        }, { 'x-gemini-guard': 'egress-unreachable' })
        return
      }

      let responded = false
      let clientGone = false
      let released = false
      const releaseSlot = () => {
        if (released) return
        released = true
        slot.release()
      }

      // The user pressing Stop, or a cancelled turn, must cancel the upstream
      // request too: an abandoned generation keeps billing and looks like
      // hammering from the vendor's side.
      res.on('close', () => {
        if (res.writableEnded) return
        clientGone = true
        upstreamRequest.destroy(new Error('客户端已断开'))
        releaseSlot()
      })

      const timer = setTimeout(() => {
        if (!responded) log.warn('上游响应超时', `${target.id} ${requestPath}`)
        upstreamRequest.destroy(new Error('上游请求超时'))
      }, cfg.requestTimeoutMs)

      upstreamRequest.on('error', (error) => {
        clearTimeout(timer)
        releaseSlot()
        if (clientGone) {
          log.info('客户端取消，已中止上游请求', `${target.id} ${requestPath}`)
          return
        }
        if (responded) {
          guard.recordOutcome(target.id, { kind: 'late-abort', detail: `响应中断：${error.message}` })
          res.destroy(error)
          return
        }
        guard.recordOutcome(target.id, { kind: 'transport', detail: `上游请求失败：${error.message}` })
        writeJson(res, 502, {
          error: { code: 502, message: `[dsh-gemini-guard] 上游请求失败：${error.message}`, status: 'UNAVAILABLE' },
        }, { 'x-gemini-guard': 'upstream-error' })
      })

      upstreamRequest.on('response', (upstreamResponse) => {
        responded = true
        clearTimeout(timer)
        const status = upstreamResponse.statusCode ?? 0
        const headers = {}
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (value === undefined) continue
          if (HOP_BY_HOP.has(name)) continue
          if (name === 'content-encoding' || name === 'content-length') continue
          headers[name] = value
        }
        headers['x-gemini-guard'] = 'pass'

        const { stream } = decodeBody(upstreamResponse)

        if (status >= 400) {
          const errorChunks = []
          let errorBytes = 0
          stream.on('data', (chunk) => {
            errorBytes += chunk.length
            if (errorBytes <= 262144) errorChunks.push(chunk)
          })
          stream.on('end', () => {
            releaseSlot()
            const text = Buffer.concat(errorChunks).toString('utf8')
            const verdict = classifyUpstreamError(status, text, upstreamResponse.headers)
            if (verdict.kind !== 'client') {
              guard.recordOutcome(target.id, {
                kind: verdict.kind,
                detail: `${target.id} HTTP ${status}: ${verdict.detail}`,
                status,
                retryAfterMs: verdict.retryAfterMs,
              })
            }
            headers['x-gemini-guard'] = `upstream-${status}`
            headers['x-gemini-guard-kind'] = verdict.kind
            headers['content-length'] = String(Buffer.byteLength(text))
            headers['content-type'] = headers['content-type'] ?? 'application/json; charset=utf-8'
            if (clientGone) return
            res.writeHead(status, headers)
            res.end(text)
          })
          stream.on('error', (error) => {
            releaseSlot()
            if (clientGone) return
            guard.recordOutcome(target.id, { kind: 'late-abort', detail: `读取上游错误响应失败：${error.message}` })
            res.destroy(error)
          })
          return
        }

        const streaming = cfg.features.streamWatch && isStreamingRequest(requestPath, headers['content-type'])
        let complete = false

        res.writeHead(status, headers)
        stream.on('data', (chunk) => {
          if (!streaming || complete) return
          if (sawTerminator(chunk.toString('utf8'))) complete = true
        })
        stream.on('end', () => {
          releaseSlot()
          if (streaming && !complete) {
            guard.recordOutcome(target.id, { kind: 'late-abort', detail: `流在无结束标记的情况下关闭：${target.id} ${requestPath}` })
          } else if (!clientGone) {
            guard.recordOutcome(target.id, { kind: 'ok' })
          }
          if (!res.writableEnded) res.end()
        })
        stream.on('error', (error) => {
          releaseSlot()
          if (clientGone) return
          guard.recordOutcome(target.id, { kind: 'late-abort', detail: `响应流错误：${error.message}` })
          if (!res.writableEnded) res.destroy(error)
        })
        upstreamResponse.on('aborted', () => {
          if (clientGone) return
          guard.recordOutcome(target.id, { kind: 'late-abort', detail: '上游在响应中途断开（aborted）' })
        })
        stream.pipe(res)
      })

      upstreamRequest.end(body.length > 0 ? body : undefined)
    }
  }

  return server
}
