// Socket plumbing: build exactly one outbound connection per request, through
// an optional upstream HTTP proxy, with TLS added on top. Nothing here falls
// back to a different route: if the configured path is down, the call fails.
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'

/**
 * @param {object} netOptions
 * @param {string} netOptions.proxy             '' or http(s)://host:port
 * @param {number} netOptions.connectTimeoutMs
 * @param {number} netOptions.tlsTimeoutMs
 * @param {string} netOptions.userAgent
 * @param {string} netOptions.acceptLanguage
 */
export function parseProxy(value) {
  if (!value) return null
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`egress.proxy 不是合法 URL：${value}（示例：http://127.0.0.1:7890）`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`egress.proxy 只支持 http:// 与 https://：${value}。SOCKS5 请改用本地客户端提供的 HTTP/混合端口`)
  }
  const authorization = url.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
    : ''
  return {
    protocol: url.protocol,
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    authorization,
  }
}

export function connectTcp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`连接 ${host}:${port} 超时（${timeoutMs} ms）`))
    }, timeoutMs)
    const settle = (error) => {
      clearTimeout(timer)
      socket.removeListener('error', settle)
      socket.removeListener('connect', onConnect)
      if (error) reject(error)
      else resolve(socket)
    }
    const onConnect = () => settle(null)
    socket.once('error', settle)
    socket.once('connect', onConnect)
  })
}

function readHandshake(socket, marker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('等待上游代理握手响应超时'))
    }, timeoutMs)
    function cleanup() {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    function onData(chunk) {
      buffer += chunk.toString('latin1')
      const index = buffer.indexOf(marker)
      if (index === -1) return
      const head = buffer.slice(0, index + marker.length)
      const rest = Buffer.from(buffer.slice(index + marker.length), 'latin1')
      cleanup()
      if (rest.length > 0) socket.unshift(rest)
      resolve(head)
    }
    function onError(error) {
      cleanup()
      reject(error)
    }
    function onClose() {
      cleanup()
      reject(new Error('上游代理在握手阶段关闭了连接'))
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

async function openProxiedSocket(proxy, host, port, timeoutMs, tlsTimeoutMs) {
  let socket = await connectTcp(proxy.host, proxy.port, timeoutMs)
  if (proxy.protocol === 'https:') socket = await wrapTls(socket, proxy.host, tlsTimeoutMs)
  const lines = [
    `CONNECT ${host}:${port} HTTP/1.1`,
    `Host: ${host}:${port}`,
    'Proxy-Connection: keep-alive',
  ]
  if (proxy.authorization) lines.push(`Proxy-Authorization: ${proxy.authorization}`)
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  const head = await readHandshake(socket, '\r\n\r\n', timeoutMs)
  const statusLine = head.split('\r\n')[0] ?? ''
  if (!/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) {
    socket.destroy()
    throw new Error(`上游代理拒绝 CONNECT ${host}:${port}：${statusLine}`)
  }
  return socket
}

export function wrapTls(socket, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername, ALPNProtocols: ['http/1.1'] })
    const timer = setTimeout(() => {
      secured.destroy()
      reject(new Error(`与 ${servername} 的 TLS 握手超时（${timeoutMs} ms）`))
    }, timeoutMs)
    const settle = (error) => {
      clearTimeout(timer)
      secured.removeListener('error', settle)
      secured.removeListener('secureConnect', onSecure)
      if (error) reject(error)
      else resolve(secured)
    }
    const onSecure = () => settle(null)
    secured.once('error', settle)
    secured.once('secureConnect', onSecure)
  })
}

export async function openOutbound(netOptions, host, port, { useTls = port === 443, timeoutMs } = {}) {
  const connectTimeout = timeoutMs ?? netOptions.connectTimeoutMs
  const proxy = parseProxy(netOptions.proxy)
  const socket = proxy
    ? await openProxiedSocket(proxy, host, port, connectTimeout, netOptions.tlsTimeoutMs)
    : await connectTcp(host, port, connectTimeout)
  if (!useTls) return socket
  return wrapTls(socket, host, netOptions.tlsTimeoutMs)
}

/** An Agent that hands its one pre-built socket to one request and never pools. */
class SingleSocketAgent extends http.Agent {
  constructor(socket) {
    super({ keepAlive: false, maxSockets: 1 })
    this.pendingSocket = socket
  }

  createConnection() {
    const socket = this.pendingSocket
    this.pendingSocket = null
    return socket
  }
}

export async function createTunneledRequest(netOptions, { host, port, method, path, headers, useTls = true }) {
  const secured = await openOutbound(netOptions, host, port, { useTls })
  const agent = new SingleSocketAgent(secured)
  return http.request({ host, port, method, path, headers, agent, setHost: false })
}

/** GET a small JSON/text resource through the same guarded egress path. */
export function getThroughEgress(netOptions, url, { timeoutMs, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`探测地址不是合法 URL：${url}`))
      return
    }
    const secure = parsed.protocol === 'https:'
    const port = Number(parsed.port || (secure ? 443 : 80))
    const requestPath = `${parsed.pathname}${parsed.search}`
    const startedAt = Date.now()

    createTunneledRequest(netOptions, {
      host: parsed.hostname,
      port,
      method: 'GET',
      path: requestPath,
      headers: {
        host: parsed.hostname,
        accept: 'application/json,text/plain,*/*',
        'accept-language': netOptions.acceptLanguage,
        'user-agent': netOptions.userAgent,
        connection: 'close',
        ...headers,
      },
      useTls: secure,
    }).then((request) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(() => {
        request.destroy()
        finish(new Error(`探测请求超时（${timeoutMs} ms）：${url}`))
      }, timeoutMs)

      request.once('error', (error) => finish(error))
      request.once('response', (response) => {
        const chunks = []
        let bytes = 0
        response.on('data', (chunk) => {
          bytes += chunk.length
          if (bytes > 262144) {
            request.destroy()
            finish(new Error('探测响应超过 256 KiB'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          finish(null, {
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            elapsedMs: Date.now() - startedAt,
          })
        })
        response.on('error', (error) => finish(error))
      })
      request.end()
    }, reject)
  })
}
