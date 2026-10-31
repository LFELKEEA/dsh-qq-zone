import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { callAction, OneBotError } from '../lib/onebot.js'

async function stub(handler) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => handler(req, res, body ? JSON.parse(body) : null))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { httpUrl: `http://127.0.0.1:${port}`, token: 'tok', close: () => new Promise((resolve) => server.close(resolve)) }
}

test('callAction 成功时返回 data', async () => {
  const s = await stub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { tid: 'abc' } }))
  })
  try {
    const data = await callAction(s, 'send_qzone_msg', { content: 'hi' })
    assert.deepEqual(data, { tid: 'abc' })
  } finally {
    await s.close()
  }
})

test('令牌不对报 onebot-unauthorized', async () => {
  const s = await stub((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"status":"failed"}')
  })
  try {
    await assert.rejects(() => callAction(s, 'get_login_info'), (error) => {
      assert.ok(error instanceof OneBotError)
      assert.equal(error.code, 'onebot-unauthorized')
      return true
    })
  } finally {
    await s.close()
  }
})

test('动作不存在报 onebot-action-missing（提示升级 SnowLuma）', async () => {
  const s = await stub((_req, res) => {
    res.writeHead(404)
    res.end('not found')
  })
  try {
    await assert.rejects(() => callAction(s, 'send_qzone_msg'), (error) => {
      assert.equal(error.code, 'onebot-action-missing')
      assert.match(error.hint, /SnowLuma/)
      return true
    })
  } finally {
    await s.close()
  }
})

test('retcode 非 0 报 onebot-rejected 并带上原始 retcode', async () => {
  const s = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'failed', retcode: 1200, wording: '空间未开通' }))
  })
  try {
    await assert.rejects(() => callAction(s, 'send_qzone_msg'), (error) => {
      assert.equal(error.code, 'onebot-rejected')
      assert.equal(error.retcode, 1200)
      assert.match(error.message, /空间未开通/)
      return true
    })
  } finally {
    await s.close()
  }
})

test('连不上报 onebot-unreachable 并带上提示', async () => {
  await assert.rejects(
    () => callAction({ httpUrl: 'http://127.0.0.1:1', token: '' }, 'get_login_info', {}, { timeoutMs: 2000 }),
    (error) => {
      assert.equal(error.code, 'onebot-unreachable')
      assert.match(error.hint, /SnowLuma/)
      return true
    },
  )
})