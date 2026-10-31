// 图片输入统一入口：本地路径 / http(s) / data: URL / base64:// / DSH 附件 id / QQ 消息 id。
// 每种都返回 { buffer, mimeType, source }，上层只管把 buffer 喂给视觉模型或 OCR。
import fs from 'node:fs'
import path from 'node:path'
import { dshHome } from './discover.js'
import { callAction, resolveTarget } from './onebot.js'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

export class ImageInputError extends Error {
  constructor(message, { code = 'image-input-failed', hint = '' } = {}) {
    super(message)
    this.name = 'ImageInputError'
    this.code = code
    this.hint = hint
  }
}

export function mimeFromPath(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/jpeg'
}

function pathFromFileUrl(raw) {
  // file:///D:/a/b.png（三斜杠）会留下前导斜杠，existsSync 就找不到；顺带解掉百分号编码。
  let value = decodeURIComponent(String(raw).replace(/^file:\/{2,}/i, ''))
  if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1)
  return value
}

function mimeFromMagic(buffer) {
  if (!buffer || buffer.length < 12) return 'image/png'
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  return 'image/png'
}

async function fromUrl(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new ImageInputError(`下载图片失败：HTTP ${res.status} ${url}`, { code: 'image-download-failed' })
  const buffer = Buffer.from(await res.arrayBuffer())
  const headerType = String(res.headers.get('content-type') ?? '')
  const mimeType = headerType.startsWith('image/') ? headerType.split(';')[0] : mimeFromMagic(buffer)
  return { buffer, mimeType, source: url }
}

function fromDataUrl(raw) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(raw)
  if (!match) throw new ImageInputError('这不是合法的 data URL', { code: 'image-bad-data-url' })
  const mimeType = match[1] || 'image/png'
  const isBase64 = Boolean(match[2])
  const payload = match[3] ?? ''
  const buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'binary')
  return { buffer, mimeType, source: 'data-url' }
}

function attachmentPath(hash, env) {
  const home = dshHome(env)
  const clean = hash.replace(/^sha256:/, '').toLowerCase()
  return path.join(home, 'attachments', 'v1', 'objects', clean.slice(0, 2), clean)
}

/** 从 QQ 消息里抠出图片：get_msg → 图片段 url/file → 下载。 */
async function fromQqMessage(messageId, { env, timeoutMs }) {
  const target = await resolveTarget({ env })
  const msg = await callAction(target, 'get_msg', { message_id: Number(messageId) }, { timeoutMs: 15_000 })
  const segments = Array.isArray(msg?.message) ? msg.message : []
  const images = segments.filter((item) => item?.type === 'image').map((item) => item.data ?? {})
  if (!images.length) {
    throw new ImageInputError(`消息 ${messageId} 里没有图片`, { code: 'image-not-in-message', hint: '确认消息 id 对得上，且这条消息真的带图。' })
  }
  const first = images[0]
  const url = String(first.url ?? first.file ?? '')
  if (!url) throw new ImageInputError('QQ 图片段里没有可用的 url/file', { code: 'image-segment-empty' })
  if (/^https?:\/\//i.test(url)) return fromUrl(url, timeoutMs)
  // file:// 或本地缓存路径
  const local = /^file:/i.test(url) ? pathFromFileUrl(url) : url
  if (fs.existsSync(local)) {
    return { buffer: fs.readFileSync(local), mimeType: mimeFromPath(local), source: local }
  }
  throw new ImageInputError(`QQ 图片地址既不是 http 也不是本地文件：${url}`, { code: 'image-url-unsupported' })
}

/** 统一入口。优先级：data: / base64:// / sha256: / http(s) / 本地路径 / QQ 消息 id。 */
export async function loadImage({ image, messageId, env = process.env, timeoutMs = 20_000 } = {}) {
  const raw = String(image ?? '').trim()
  if (!raw && messageId) return fromQqMessage(messageId, { env, timeoutMs })
  if (!raw) {
    throw new ImageInputError('没给图片', {
      code: 'image-missing',
      hint: '传 image（本地路径 / http(s) URL / data: URL / base64:// / sha256: 附件 id），或传 messageId（QQ 消息 id）。',
    })
  }
  if (/^data:/i.test(raw)) return fromDataUrl(raw)
  if (/^base64:\/\//i.test(raw)) {
    const buffer = Buffer.from(raw.slice('base64://'.length), 'base64')
    return { buffer, mimeType: mimeFromMagic(buffer), source: 'base64' }
  }
  if (/^sha256:/i.test(raw)) {
    const file = attachmentPath(raw, env)
    if (!fs.existsSync(file)) throw new ImageInputError(`找不到附件 ${raw}（期望在 ${file}）`, { code: 'image-attachment-missing' })
    return { buffer: fs.readFileSync(file), mimeType: mimeFromMagic(fs.readFileSync(file)), source: file }
  }
  if (/^https?:\/\//i.test(raw)) return fromUrl(raw, timeoutMs)
  if (/^file:\/\//i.test(raw)) {
    const file = pathFromFileUrl(raw)
    if (!fs.existsSync(file)) throw new ImageInputError(`文件不存在：${file}`, { code: 'image-file-missing' })
    const buffer = fs.readFileSync(file)
    return { buffer, mimeType: mimeFromMagic(buffer), source: file }
  }
  // 纯 64 位 hex 当作附件哈希
  if (/^[0-9a-f]{64}$/i.test(raw)) return loadImage({ image: `sha256:${raw}`, env, timeoutMs })
  if (!fs.existsSync(raw)) {
    throw new ImageInputError(`文件不存在：${raw}`, {
      code: 'image-file-missing',
      hint: 'Windows 路径要完整（含盘符）；也可以直接给 http(s) 图片地址。',
    })
  }
  if (IMAGE_EXT.has(path.extname(raw).toLowerCase()) === false) {
    throw new ImageInputError(`这不像图片文件：${raw}`, { code: 'image-not-image', hint: '支持 png/jpg/jpeg/webp/gif/bmp。' })
  }
  const buffer = fs.readFileSync(raw)
  return { buffer, mimeType: mimeFromPath(raw), source: raw }
}