// dsh-qq-zone：把「发 QQ 空间」和「识图」做成 DSH 工具。
//
// 两条链路都复用本机既有能力，不引入任何 key：
//   · 空间 → SnowLuma 的 OneBot qzone_* action（HTTP 127.0.0.1:3000）
//   · 识图 → DSH 本地 OpenAI 兼容网关（127.0.0.1:8326）里的多模态模型；
//            没有视觉模型时退回 Windows 内置 OCR（只认字）
import { callAction, resolveTarget, OneBotError } from './onebot.js'
import { describeImage, ocrImage, gatewayStatus, VisionError } from './vision.js'
import { loadImage, ImageInputError } from './image-input.js'

export const name = 'dsh-qq-zone'
export const inject = ['tools']

const UGC_RIGHT_BY_PERMISSION = {
  public: 1,
  all: 1,
  everyone: 1,
  friends: 4,
  friend: 4,
  some: 16,
  private: 64,
  self: 64,
  onlyme: 64,
  hide: 128,
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

function fail(error) {
  const code = error?.code ?? 'unexpected'
  const hint = error?.hint ? `\n提示：${error.hint}` : ''
  return `❌ ${error?.message ?? error}${hint}\n(code: ${code})`
}

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean)
  const text = String(value ?? '').trim()
  return text ? [text] : []
}

function toUgcRight(permission, targetUins) {
  if (permission === undefined || permission === null || permission === '') {
    return targetUins.length ? 16 : 1
  }
  if (typeof permission === 'number') return permission
  const key = String(permission).trim().toLowerCase()
  if (/^\d+$/.test(key)) return Number(key)
  const mapped = UGC_RIGHT_BY_PERMISSION[key]
  if (!mapped) {
    throw new OneBotError(`不认识的可见范围：${permission}`, {
      code: 'qzone-bad-permission',
      hint: '可用 public（所有人）/ friends（好友）/ private（仅自己）/ some（部分好友，配 targetUins）/ hide（部分好友不可见）。',
    })
  }
  return mapped
}

function describeRight(ugcRight) {
  const table = { 1: '所有人可见', 4: '好友可见', 16: '部分好友可见', 64: '仅自己可见', 128: '部分好友不可见' }
  return table[ugcRight] ?? `ugc_right=${ugcRight}`
}

function formatTime(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function preview(text, limit = 80) {
  const flat = String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

async function publish({ content, images, permission, targetUins }, { env }) {
  const text = String(content ?? '').trim()
  const list = asList(images)
  if (!text && !list.length) {
    throw new OneBotError('说说内容是空的：至少要有一段文字或一张图。', { code: 'qzone-empty-content' })
  }
  const uins = asList(targetUins)
  const ugcRight = toUgcRight(permission, uins)
  const target = await resolveTarget({ env })
  const params = { content: text, ugc_right: ugcRight }
  if (list.length) {
    params.images = list.map((item) => {
      if (/^(file|http|https|base64):\/\//i.test(item) || /^data:/i.test(item)) return item
      const normalized = item.replace(/\\/g, '/')
      return /^[A-Za-z]:\//.test(normalized) ? `file:///${normalized}` : item
    })
  }
  if (ugcRight === 16 || ugcRight === 128) {
    if (!uins.length) {
      throw new OneBotError('选了「部分好友可见/不可见」，但没给 targetUins。', { code: 'qzone-missing-target-uins', hint: '传 targetUins: ["QQ号"]。' })
    }
    params.target_uins = uins
  }
  const data = await callAction(target, 'send_qzone_msg', params, { timeoutMs: 60_000 })
  const tid = data?.tid ?? ''
  const lines = [
    `✅ 说说已发出（${target.nickname || target.uin}）：tid=${tid}`,
    `可见范围：${describeRight(ugcRight)}`,
    text ? `正文：${preview(text)}` : '',
    list.length ? `配图：${list.length} 张` : '',
    tid ? `删除：qzone_delete tid=${tid}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

async function timeline({ source = 'mine', count = 10, targetUin }, { env }) {
  const target = await resolveTarget({ env })
  const limit = Math.max(1, Math.min(Number(count) || 10, 30))
  if (String(source) === 'feeds') {
    const data = await callAction(target, 'get_qzone_feeds', { count: limit }, { timeoutMs: 30_000 })
    const feeds = Array.isArray(data?.feeds) ? data.feeds.slice(0, limit) : []
    if (!feeds.length) return '📭 好友动态是空的（或者账号没有空间访问权限）。'
    const lines = feeds.map((feed, index) => {
      const who = feed.nickname || feed.uin || '?'
      const when = formatTime(feed.time)
      const body = preview(feed.content, 100)
      const meta = [when, feed.like_count ? `赞 ${feed.like_count}` : '', feed.comment_count ? `评 ${feed.comment_count}` : ''].filter(Boolean).join(' · ')
      return `${index + 1}. ${who}${meta ? `（${meta}）` : ''}：${body || '(无文字)'}${feed.tid ? ` [tid=${feed.tid}]` : ''}`
    })
    return `📣 好友动态（${feeds.length} 条）\n${lines.join('\n')}`
  }
  const params = { num: limit }
  if (targetUin) params.target_uin = String(targetUin)
  const data = await callAction(target, 'get_qzone_msg_list', params, { timeoutMs: 30_000 })
  const list = Array.isArray(data?.msglist) ? data.msglist.slice(0, limit) : []
  if (!list.length) return '📭 空间里还没有说说。'
  const lines = list.map((item, index) => {
    const when = formatTime(item.time)
    return `${index + 1}. ${when ? `${when} ` : ''}${preview(item.content, 100) || '(无文字)'} [tid=${item.tid}]`
  })
  return `📝 我的说说（共 ${data?.total ?? list.length} 条，显示 ${lines.length} 条）\n${lines.join('\n')}`
}

async function remove({ tid }, { env }) {
  const id = String(tid ?? '').trim()
  if (!id) throw new OneBotError('要删哪条？给我 tid。', { code: 'qzone-missing-tid', hint: '先用 qzone_timeline 看列表里的 [tid=...]。' })
  const target = await resolveTarget({ env })
  await callAction(target, 'delete_qzone_msg', { tid: id }, { timeoutMs: 30_000 })
  return `🗑️ 已删除 tid=${id}`
}

async function like({ tid, targetUin, abstime, unlike }, { env }) {
  const id = String(tid ?? '').trim()
  if (!id) throw new OneBotError('要赞哪条？给我 tid。', { code: 'qzone-missing-tid' })
  const target = await resolveTarget({ env })
  const params = { tid: id }
  if (targetUin) params.target_uin = String(targetUin)
  if (abstime) params.abstime = Number(abstime)
  const action = unlike ? 'unlike_qzone' : 'like_qzone'
  await callAction(target, action, params, { timeoutMs: 30_000 })
  return `${unlike ? '↩️ 已取消赞' : '👍 已点赞'} tid=${id}`
}

async function comment({ tid, content, targetUin }, { env }) {
  const id = String(tid ?? '').trim()
  const text = String(content ?? '').trim()
  if (!id) throw new OneBotError('要评论哪条？给我 tid。', { code: 'qzone-missing-tid' })
  if (!text) throw new OneBotError('评论内容是空的。', { code: 'qzone-empty-comment' })
  const target = await resolveTarget({ env })
  const params = { tid: id, content: text }
  if (targetUin) params.target_uin = String(targetUin)
  await callAction(target, 'comment_qzone', params, { timeoutMs: 30_000 })
  return `💬 已评论 tid=${id}：${preview(text)}`
}

async function profile({ mode = 'get', targetUin, name: nick, description }, { env }) {
  const target = await resolveTarget({ env })
  const params = {}
  if (targetUin) params.target_uin = String(targetUin)
  if (String(mode) === 'set') {
    if (nick === undefined && description === undefined) {
      throw new OneBotError('要改资料就给我 name 或 description（传空串表示清空）。', { code: 'qzone-empty-profile' })
    }
    if (nick !== undefined) params.name = String(nick)
    if (description !== undefined) params.description = String(description)
    const data = await callAction(target, 'set_qzone_profile', params, { timeoutMs: 30_000 })
    return `✏️ 空间资料已更新：${JSON.stringify(data ?? {})}`
  }
  const data = await callAction(target, 'get_qzone_profile', params, { timeoutMs: 30_000 })
  const owner = targetUin ? `QQ ${targetUin}` : `${target.nickname || ''}(${target.uin || '?'})`
  return [`👤 ${owner} 的空间资料`, `昵称：${data?.name || '(空)'}`, `签名：${data?.description || '(空)'}`].join('\n')
}

async function seeImage({ image, messageId, prompt, mode = 'describe', model }, { env }) {
  const loaded = await loadImage({ image, messageId, env })
  const sizeKb = Math.max(1, Math.round(loaded.buffer.length / 1024))
  const header = `图片来源：${loaded.source}（${loaded.mimeType}, ${sizeKb} KB）`
  if (String(mode) === 'ocr') {
    const result = await ocrImage({ filePath: loaded.source })
    return `${header}\n${result.text}`
  }
  try {
    const result = await describeImage({ buffer: loaded.buffer, mimeType: loaded.mimeType, prompt, model, env })
    return `${header}\n模型：${result.model}（${result.ms} ms）\n${result.text}`
  } catch (error) {
    if (!(error instanceof VisionError)) throw error
    // 视觉后端不可用时退回 OCR：至少把图里的字读出来，别直接失败。
    try {
      const fallback = await ocrImage({ filePath: loaded.source })
      return `${header}\n⚠️ 视觉模型不可用（${error.code}），已退回 Windows OCR（只认出文字）：\n${fallback.text}`
    } catch (ocrError) {
      throw new VisionError(`${error.message}\nOCR 兜底也失败：${ocrError.message}`, { code: 'vision-and-ocr-failed', hint: error.hint })
    }
  }
}

function collect(defs) {
  return defs.filter(Boolean)
}

/** 注册全部工具；返回后由 cordis 负责卸载。 */
export function apply(ctx) {
  const register = (definition) => ctx.effect(() => ctx.tools.register(definition), `dsh-qq-zone: ${definition.name}`)

  register({
    name: 'qzone_publish',
    description:
      '发一条 QQ 空间说说（可带图）。走本机 SnowLuma 的 qzone 接口，用的是机器人自己登录的 QQ。' +
      '默认所有人可见；permission=private 只有自己能看见（适合试写）。成功返回 tid，可用于删除/点赞/评论。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '说说正文（可以是空串，但图文至少要有一个）' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '配图：本地路径（如 D:/pics/a.png）、http(s) 地址、base64:// 或 data: URL',
        },
        permission: {
          type: 'string',
          description: '可见范围：public（所有人，默认）/ friends（好友）/ private（仅自己）/ some（部分好友，需 targetUins）/ hide（部分好友不可见）',
        },
        targetUins: { type: 'array', items: { type: 'string' }, description: '部分好友可见/不可见时的 QQ 号列表' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await see(() => publish(args ?? {}, { env: textEnv(exec) }))
    },
  })

  register({
    name: 'qzone_timeline',
    description: '看 QQ 空间：source=mine（我发的说说，默认）或 source=feeds（好友动态）。返回每条的时间、正文摘要和 tid。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'mine（我的说说）/ feeds（好友动态）' },
        count: { type: 'number', description: '最多返回几条，默认 10，上限 30' },
        targetUin: { type: 'string', description: '看别人的空间时给 QQ 号' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await see(() => timeline(args ?? {}, { env: textEnv(exec) }))
    },
  })

  register({
    name: 'qzone_delete',
    description: '删除一条自己发的 QQ 空间说说。需要 tid（从 qzone_timeline 或 qzone_publish 的返回里拿）。',
    parameters: {
      type: 'object',
      properties: { tid: { type: 'string', description: '说说 id' } },
      required: ['tid'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await see(() => remove(args ?? {}, { env: textEnv(exec) }))
    },
  })

  register({
    name: 'qzone_like',
    description: '给一条 QQ 空间说说点赞或取消赞。',
    parameters: {
      type: 'object',
      properties: {
        tid: { type: 'string', description: '说说 id' },
        targetUin: { type: 'string', description: '这条说说属于谁（好友的说说要填）' },
        abstime: { type: 'number', description: '说说发表时间的 unix 秒（好友说说建议填，更可靠）' },
        unlike: { type: 'boolean', description: 'true = 取消赞' },
      },
      required: ['tid'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await see(() => like(args ?? {}, { env: textEnv(exec) }))
    },
  })

  register({
    name: 'qzone_comment',
    description: '评论一条 QQ 空间说说（纯文字）。',
    parameters: {
      type: 'object',
      properties: {
        tid: { type: 'string', description: '说说 id' },
        content: { type: 'string', description: '评论内容' },
        targetUin: { type: 'string', description: '这条说说属于谁（好友的说说要填）' },
      },
      required: ['tid', 'content'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await see(() => comment(args ?? {}, { env: textEnv(exec) }))
    },
  })

  register({
    name: 'qzone_profile',
    description: '读或改 QQ 空间的昵称与个性签名。mode=get 读（默认），mode=set 写。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'get（默认）或 set' },
        targetUin: { type: 'string', description: '看别人的资料时给 QQ 号' },
        name: { type: 'string', description: 'set 时的新昵称（空串=清空）' },
        description: { type: 'string', description: 'set 时的新签名（空串=清空）' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await see(() => profile(args ?? {}, { env: textEnv(exec) }))
    },
  })

  register({
    name: 'see_image',
    description:
      '看一张图并说出内容（不是只读文字）：给本地路径、http(s) 链接、base64/data URL、sha256: 附件 id，' +
      '或者直接给 QQ 消息 id（messageId）让工具自己去消息里取图。' +
      'mode=describe（默认，理解画面+读文字）或 mode=ocr（只做文字识别）。',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '本地路径 / http(s) / data: / base64:// / sha256: 附件 id' },
        messageId: { type: 'string', description: 'QQ 消息 id：从这条消息里取第一张图' },
        prompt: { type: 'string', description: '想重点看什么（默认让它描述画面并读出文字）' },
        mode: { type: 'string', description: 'describe（默认）/ ocr（只认字）' },
        model: { type: 'string', description: '指定视觉模型 id（默认自动挑一个支持图片输入的）' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await see(() => seeImage(args ?? {}, { env: textEnv(exec) }))
    },
  })

  register({
    name: 'vision_status',
    description: '诊断识图后端：本地 OpenAI 网关通不通、有几个能看图的模型、OCR 兜底可不可用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      return await see(async () => {
        const status = await gatewayStatus({ env: textEnv(exec) })
        const lines = [`平台：${status.platform}，OCR 兜底：${status.ocr ? '可用' : '不可用'}`]
        let reachable = 0
        for (const gateway of status.gateways) {
          if (!gateway.reachable) {
            const source = gateway.urlSource ? `，来源：${gateway.urlSource}` : ''
            lines.push(`网关 ${gateway.baseUrl}：不可达${source}（${gateway.error}）`)
            continue
          }
          reachable += 1
          lines.push(`网关 ${gateway.baseUrl}：OK，${gateway.models} 个模型，其中 ${gateway.visionModels} 个能看图`)
          lines.push(`  key 来源：${gateway.keySource}`)
          if (gateway.preferred) lines.push(`  默认会用：${gateway.preferred}`)
        }
        if (!reachable) {
          lines.push(
            '提示：识图要有一个 OpenAI 兼容网关 —— 本机通常是第三方插件 dsh-our-free-model 提供的 127.0.0.1:8326；' +
              '也可以设 OPENAI_BASE_URL + OPENAI_API_KEY（或 DSH_OPENAI_GATEWAY_BASE/API_KEY）指向任意兼容服务。' +
              '没有网关时 see_image 会自动退回 Windows OCR，只能读文字、看不懂画面。',
          )
        }
        return lines.join('\n')
      })
    },
  })
}

async function see(task) {
  try {
    return await task()
  } catch (error) {
    if (error instanceof OneBotError || error instanceof VisionError || error instanceof ImageInputError) return fail(error)
    return fail(error)
  }
}

function textEnv(exec) {
  return exec?.env ?? process.env
}