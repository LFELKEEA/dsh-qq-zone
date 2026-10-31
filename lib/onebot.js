// OneBot HTTP 调用层：挑一个活着的端点、带上令牌、把 SnowLuma 的 retcode 翻译成人能看懂的错。
import { oneBotTargets } from './discover.js'

const PROBE_TTL_MS = 60_000
let probed = null

export class OneBotError extends Error {
  constructor(message, { code = 'onebot-failed', hint = '', action = '', retcode = null } = {}) {
    super(message)
    this.name = 'OneBotError'
    this.code = code
    this.hint = hint
    this.action = action
    this.retcode = retcode
  }
}

async function postJson(url, token, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  return { status: res.status, parsed, text }
}

/** 调一个 OneBot action；成功返回 data，失败抛 OneBotError（带 code / hint）。 */
export async function callAction(target, action, params = {}, { timeoutMs = 30_000 } = {}) {
  const url = `${target.httpUrl}/${action}`
  let res
  try {
    res = await postJson(url, target.token, params, timeoutMs)
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? `请求 ${action} 超时（${timeoutMs}ms）` : `连不上 ${target.httpUrl}：${error?.message ?? error}`
    throw new OneBotError(reason, {
      code: 'onebot-unreachable',
      hint: '确认 SnowLuma 正在运行、OneBot HTTP 服务已开（默认 127.0.0.1:3000），并且令牌没写错。',
      action,
    })
  }
  if (res.status === 401 || res.status === 403) {
    throw new OneBotError(`${action} 被拒绝（HTTP ${res.status}）：令牌不对，或者这个账号没开 OneBot HTTP 服务。`, {
      code: 'onebot-unauthorized',
      hint: '从 SurfCore 的 config.json 里读 snowluma.accessToken；如果是个人号/机器人号两个配置，注意端口别串。',
      action,
    })
  }
  if (res.status === 404) {
    throw new OneBotError(`${action} 不存在（HTTP 404）：当前 SnowLuma 版本没有这个动作。`, {
      code: 'onebot-action-missing',
      hint: 'qzone_* 需要 SnowLuma 2.2+；升级 SnowLuma 后重试。',
      action,
    })
  }
  const payload = res.parsed
  if (!payload) {
    throw new OneBotError(`${action} 返回了无法解析的内容（HTTP ${res.status}）：${res.text.slice(0, 200)}`, {
      code: 'onebot-bad-response',
      action,
    })
  }
  const retcode = payload.retcode ?? null
  const ok = payload.status === 'ok' || retcode === 0
  if (!ok) {
    const wording = payload.wording || payload.message || payload.error || ''
    throw new OneBotError(`${action} 失败：retcode=${retcode}${wording ? ` ${wording}` : ''}`, {
      code: 'onebot-rejected',
      hint: 'QQ 侧可能要求重新登录、或者这个动作需要更高权限（比如别人的空间不可见）。',
      action,
      retcode,
    })
  }
  return payload.data
}

/** 找第一个真的登录着 QQ 的端点，60 秒内复用结果。 */
export async function resolveTarget({ force = false, env = process.env } = {}) {
  if (!force && probed && Date.now() - probed.at < PROBE_TTL_MS) return probed.target
  const { targets, sources } = oneBotTargets({ env })
  if (!targets.length) {
    throw new OneBotError('没有找到任何 OneBot 端点。', {
      code: 'onebot-not-configured',
      hint: '在 SurfCore 配置里设置 snowluma.httpUrl / accessToken，或设置环境变量 QZONE_ONEBOT_HTTP + QZONE_ONEBOT_TOKEN。',
    })
  }
  const failures = []
  for (const target of targets) {
    try {
      const login = await callAction(target, 'get_login_info', {}, { timeoutMs: 6000 })
      const uin = login?.user_id ?? null
      const nickname = login?.nickname ?? ''
      const resolved = { ...target, uin, nickname, configSources: sources }
      probed = { at: Date.now(), target: resolved }
      return resolved
    } catch (error) {
      failures.push(`${target.httpUrl}: ${error?.message ?? error}`)
    }
  }
  throw new OneBotError(`所有 OneBot 端点都不可用：${failures.join('；')}`, {
    code: 'onebot-unreachable',
    hint: '确认 SnowLuma 在跑、QQ 已登录（不是掉线态），以及 SurfCore 没把端口改成别的。',
  })
}

export function currentTarget() {
  return probed?.target ?? null
}