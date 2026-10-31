// 识图后端链：DSH 本地 OpenAI 网关（有视觉模型就用它） → Windows 内置 OCR（只认字）。
//
// 为什么不用第三方 key：本机网关 127.0.0.1:8326 已经把 DSH 里所有能用的 provider
// 都聚合成一个 OpenAI 兼容出口（key 在 ~/.dsh/openai-gateway/api-key），
// 其中几十个模型支持图片输入。走它等于「复用用户已经付过费/已登录的通道」。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { gatewayTargets } from './discover.js'

const run = promisify(execFile)

const DEFAULT_PROMPT =
  '用中文说明这张图：画面里有什么、在做什么；如果图里有文字（聊天记录、界面、截图、海报），把关键文字原样读出来；如果是截图，说清这是什么界面。不要编造看不清的内容。'

// 优先挑稳的：官方通道 > 付费视觉通道 > 免费视觉通道（免费通道可能因 Bun 缺失报 TRANSPORT）。
const MODEL_PREFERENCE = [
  'deepseek-official/',
  'deepseek-account-vision/',
  'deepseek-vision/',
  'dfy-vision/',
  'deepseek-account/',
  'our-free-model-vision/',
]

const modelCache = new Map()
const MODEL_TTL_MS = 5 * 60_000

export class VisionError extends Error {
  constructor(message, { code = 'vision-failed', hint = '', backend = '' } = {}) {
    super(message)
    this.name = 'VisionError'
    this.code = code
    this.hint = hint
    this.backend = backend
  }
}

async function listModels(target, { timeoutMs = 8000 } = {}) {
  const cached = modelCache.get(target.baseUrl)
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.models
  const res = await fetch(`${target.baseUrl}/v1/models`, {
    headers: target.key ? { authorization: `Bearer ${target.key}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new VisionError(`本地网关 ${target.baseUrl} 返回 HTTP ${res.status}`, { code: 'gateway-http', backend: 'gateway' })
  const body = await res.json()
  const models = Array.isArray(body?.data) ? body.data : []
  modelCache.set(target.baseUrl, { at: Date.now(), models })
  return models
}

function supportsImage(model) {
  return Array.isArray(model?.input) && model.input.includes('image')
}

function rankModel(id) {
  for (let i = 0; i < MODEL_PREFERENCE.length; i += 1) {
    if (id.startsWith(MODEL_PREFERENCE[i])) return i
  }
  return MODEL_PREFERENCE.length
}

/** 选一个能用图片输入的模型；prefer 命中优先。 */
export async function pickVisionModel(target, prefer = '') {
  const models = await listModels(target)
  const vision = models.filter(supportsImage).map((model) => String(model.id))
  if (!vision.length) {
    throw new VisionError(`本地网关没有支持图片输入的模型（共 ${models.length} 个模型）`, {
      code: 'no-vision-model',
      hint: '在 DSH 里启用一个视觉 provider（比如 dsh-vision-router / 免费模型插件），或换一台有视觉模型的环境。',
      backend: 'gateway',
    })
  }
  const wanted = String(prefer ?? '').trim()
  if (wanted && vision.includes(wanted)) return wanted
  if (wanted) {
    const fuzzy = vision.find((id) => id.endsWith(`/${wanted}`) || id.includes(wanted))
    if (fuzzy) return fuzzy
  }
  return [...vision].sort((a, b) => rankModel(a) - rankModel(b) || a.localeCompare(b))[0]
}

/** 问一次视觉模型。返回 {ok, backend, model, text, ms}。 */
export async function describeImage({ buffer, mimeType, prompt, model, timeoutMs = 120_000, env = process.env }) {
  if (!buffer || !buffer.length) throw new VisionError('没有拿到图片字节', { code: 'empty-image', hint: '确认图片路径/消息 id 正确，且图片没有被清理。' })
  const targets = gatewayTargets({ env })
  const failures = []
  for (const target of targets) {
    const started = Date.now()
    try {
      const chosen = await pickVisionModel(target, model)
      const dataUrl = `data:${mimeType || 'image/png'};base64,${buffer.toString('base64')}`
      const res = await fetch(`${target.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(target.key ? { authorization: `Bearer ${target.key}` } : {}),
        },
        body: JSON.stringify({
          model: chosen,
          max_tokens: 800,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: String(prompt ?? DEFAULT_PROMPT) },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      let body = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = null
      }
      if (!res.ok) {
        const message = body?.error?.message || text.slice(0, 240)
        failures.push(`${target.baseUrl} → ${chosen}: HTTP ${res.status} ${message}`)
        continue
      }
      const answer = String(body?.choices?.[0]?.message?.content ?? '').trim()
      if (!answer) {
        failures.push(`${target.baseUrl} → ${chosen}: 返回空内容`)
        continue
      }
      return { ok: true, backend: 'gateway', baseUrl: target.baseUrl, model: chosen, text: answer, ms: Date.now() - started }
    } catch (error) {
      failures.push(`${target.baseUrl}: ${error?.message ?? error}`)
    }
  }
  throw new VisionError(`视觉模型都没成功：${failures.join('；')}`, {
    code: 'vision-backend-unavailable',
    hint: '本地网关没起来（DSH 关掉时它就没了）、或者没有可用的视觉模型；可以先退回 OCR 只读文字。',
    backend: 'gateway',
  })
}

function ocrScriptPath() {
  // 必须走 fileURLToPath：中文路径在 URL 里是百分号编码，用 .pathname 会拼出不存在的路径。
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'ocr-winrt.ps1')
}

/** Windows 内置 OCR：只读文字，读不懂画面。非 Windows 直接报不可用。 */
export async function ocrImage({ filePath, timeoutMs = 60_000 } = {}) {
  if (process.platform !== 'win32') {
    throw new VisionError('当前系统不是 Windows，没有可用的本地 OCR 兜底。', { code: 'ocr-unsupported', hint: '装一个视觉 provider，或换 Windows。', backend: 'ocr' })
  }
  if (!filePath || !fs.existsSync(filePath)) {
    throw new VisionError(`OCR 找不到文件：${filePath || '(空)'}`, { code: 'ocr-file-missing', backend: 'ocr' })
  }
  const script = ocrScriptPath()
  if (!fs.existsSync(script)) {
    throw new VisionError(`OCR 脚本缺失：${script}`, { code: 'ocr-script-missing', backend: 'ocr' })
  }
  try {
    const { stdout } = await run(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', filePath],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    )
    const text = String(stdout ?? '').replace(/\r\n/g, '\n').trim()
    if (!text) {
      throw new VisionError('OCR 没有读出任何文字（图里可能确实没有文字）。', { code: 'ocr-empty', backend: 'ocr' })
    }
    return { ok: true, backend: 'ocr', text, note: '这是 Windows OCR 的结果：只有文字，没有画面理解。' }
  } catch (error) {
    if (error instanceof VisionError) throw error
    throw new VisionError(`OCR 执行失败：${error?.message ?? error}`, { code: 'ocr-failed', backend: 'ocr', hint: '脚本依赖 Windows 10/11 自带的 WinRT OCR。' })
  }
}

/** 诊断：哪些网关在、多少视觉模型、key 从哪来。 */
export async function gatewayStatus({ env = process.env } = {}) {
  const targets = gatewayTargets({ env })
  const report = []
  for (const target of targets) {
    try {
      const models = await listModels(target, { timeoutMs: 4000 })
      const vision = models.filter(supportsImage).map((model) => String(model.id))
      report.push({
        baseUrl: target.baseUrl,
        reachable: true,
        keySource: target.keySource || '(未找到 key)',
        models: models.length,
        visionModels: vision.length,
        preferred: vision.length ? [...vision].sort((a, b) => rankModel(a) - rankModel(b) || a.localeCompare(b))[0] : null,
      })
    } catch (error) {
      report.push({ baseUrl: target.baseUrl, reachable: false, error: String(error?.message ?? error) })
    }
  }
  return { platform: process.platform, ocr: process.platform === 'win32', gateways: report, prompt: DEFAULT_PROMPT }
}