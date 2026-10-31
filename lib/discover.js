// 自动发现：本机 SurfCore（OneBot 端点 + 控制台令牌）与 DSH 本地 OpenAI 网关。
//
// 设计原则（跟 dsh-peak-valley 0.3.x 一样）：别人装上就能用，不写死作者机器上的路径。
// 顺序一律是「显式配置 → 环境变量 → 已知位置 → 常见默认值」，找不到就返回空值，
// 让上层给出可行动的提示，而不是抛一句看不懂的异常。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** DSH_HOME 默认 ~/.dsh；注意 DSH_HOME 本身就是 ~/.dsh，不要再拼一层 .dsh。 */
export function dshHome(env = process.env) {
  const raw = String(env.DSH_HOME ?? '').trim()
  if (raw) return raw
  return path.join(os.homedir(), '.dsh')
}

export function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function realpathOrNull(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

/** SurfCore config.json 的候选位置（按可信度排序）。 */
export function surfcoreConfigPaths({ env = process.env, home = dshHome(env) } = {}) {
  const list = []
  const explicit = String(env.SURFCORE_CONFIG ?? '').trim()
  if (explicit) list.push(explicit)
  // `<DSH_HOME>/plugins/surfcore` 通常是 junction，指向 `<repo>/plugins/surfcore`，
  // 真正的 config.json 在仓库根（比 ~/.dsh/surfcore/config.json 新，字段也更全）。
  const link = path.join(home, 'plugins', 'surfcore')
  const real = realpathOrNull(link)
  if (real) list.push(path.join(real, '..', '..', 'config.json'))
  list.push(path.join(home, 'surfcore', 'config.json'))
  return [...new Set(list)]
}

/** 读 SurfCore 配置：多个位置都要看，缺字段互相补（老配置只在 ~/.dsh/surfcore）。 */
export function loadSurfcoreConfig({ env = process.env, home = dshHome(env) } = {}) {
  const merged = {}
  const sources = []
  for (const file of surfcoreConfigPaths({ env, home })) {
    const value = readJsonFile(file)
    if (!value) continue
    sources.push(file)
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || item === null) continue
      if (merged[key] === undefined) merged[key] = item
      else if (typeof merged[key] === 'object' && typeof item === 'object' && !Array.isArray(item)) {
        merged[key] = { ...item, ...merged[key] }
      }
    }
  }
  return { config: merged, sources }
}

function normalizeUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (/^https?:\/\//i.test(text)) return text.replace(/\/+$/, '')
  return ''
}

/** OneBot HTTP 端点候选：显式环境变量 → SurfCore snowluma 配置 → 默认 3000。 */
export function oneBotTargets({ env = process.env, home = dshHome(env) } = {}) {
  const targets = []
  const push = (httpUrl, token, source) => {
    const url = normalizeUrl(httpUrl)
    if (!url) return
    if (targets.some((item) => item.httpUrl === url)) return
    targets.push({ httpUrl: url, token: String(token ?? '').trim(), source })
  }
  push(env.QZONE_ONEBOT_HTTP, env.QZONE_ONEBOT_TOKEN, '环境变量 QZONE_ONEBOT_HTTP')
  const { config, sources } = loadSurfcoreConfig({ env, home })
  const snow = config.snowluma && typeof config.snowluma === 'object' ? config.snowluma : {}
  const token =
    snow.accessToken ??
    snow.token ??
    snow.httpToken ??
    env.QZONE_ONEBOT_TOKEN ??
    ''
  const configured = snow.httpUrl ?? snow.http ?? snow.onebotHttp ?? ''
  const port = Number(snow.httpPort ?? snow.port ?? 0)
  if (configured) push(configured, token, sources[0] ? `SurfCore 配置 ${sources[0]}` : 'SurfCore 配置')
  if (Number.isInteger(port) && port > 0) push(`http://127.0.0.1:${port}`, token, 'SurfCore 配置端口')
  push('http://127.0.0.1:3000', token, '默认 OneBot 端口 3000')
  return { targets, config, sources }
}

/** DSH 本地 OpenAI 兼容网关（dsh-our-free-model / 官方 llm 的本地出口）。 */
export function gatewayTargets({ env = process.env, home = dshHome(env) } = {}) {
  const base = normalizeUrl(env.DSH_OPENAI_GATEWAY_BASE)
  const port = Number.parseInt(String(env.DSH_OPENAI_GATEWAY_PORT ?? '').trim(), 10)
  const urls = []
  if (base) urls.push(base)
  if (Number.isInteger(port) && port > 0) urls.push(`http://127.0.0.1:${port}`)
  urls.push('http://127.0.0.1:8326')
  const keyFromEnv = String(env.DSH_OPENAI_GATEWAY_API_KEY ?? '').trim()
  let key = keyFromEnv
  let keySource = keyFromEnv ? '环境变量 DSH_OPENAI_GATEWAY_API_KEY' : ''
  if (!key) {
    const file = path.join(home, 'openai-gateway', 'api-key')
    try {
      const stored = fs.readFileSync(file, 'utf8').trim()
      if (stored) {
        key = stored
        keySource = file
      }
    } catch {
      /* 还没生成过 */
    }
  }
  const seen = new Set()
  const targets = []
  for (const url of urls) {
    if (seen.has(url)) continue
    seen.add(url)
    targets.push({ baseUrl: url, key, keySource })
  }
  return targets
}

/** 控制台（SurfCore bridge HTTP）地址与令牌，用于取 QQ 消息里的图片。 */
export function consoleTargets({ env = process.env, home = dshHome(env) } = {}) {
  const { config, sources } = loadSurfcoreConfig({ env, home })
  const url = normalizeUrl(config.consoleUrl ?? config.bridge?.consoleUrl ?? '') || 'http://127.0.0.1:3100'
  const token = String(config.consoleToken ?? '').trim()
  return { baseUrl: url, token, sources }
}