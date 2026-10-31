import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dshHome, loadSurfcoreConfig, oneBotTargets, gatewayTargets } from '../lib/discover.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qq-zone-'))
}

test('dshHome 优先用 DSH_HOME，且不会再多拼一层 .dsh', () => {
  assert.equal(dshHome({ DSH_HOME: 'D:/x/.dsh' }), 'D:/x/.dsh')
  assert.equal(dshHome({ DSH_HOME: '' }).endsWith('.dsh'), true)
})

test('oneBotTargets 从 SurfCore 配置读端口与令牌', () => {
  const home = tempHome()
  fs.mkdirSync(path.join(home, 'surfcore'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'surfcore', 'config.json'),
    JSON.stringify({ snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'tok-1' } }),
  )
  const { targets } = oneBotTargets({ env: { DSH_HOME: home }, home })
  assert.equal(targets[0].httpUrl, 'http://127.0.0.1:3000')
  assert.equal(targets[0].token, 'tok-1')
  assert.match(targets[0].source, /SurfCore/)
})

test('oneBotTargets 环境变量优先，并且总是留一个默认 3000 兜底', () => {
  const home = tempHome()
  const { targets } = oneBotTargets({ env: { DSH_HOME: home, QZONE_ONEBOT_HTTP: 'http://127.0.0.1:4000', QZONE_ONEBOT_TOKEN: 'env-tok' }, home })
  assert.equal(targets[0].httpUrl, 'http://127.0.0.1:4000')
  assert.equal(targets[0].token, 'env-tok')
  assert.equal(targets.at(-1).httpUrl, 'http://127.0.0.1:3000')
})

test('loadSurfcoreConfig 会把仓库根与 ~/.dsh 里的配置互补', () => {
  const home = tempHome()
  const repo = path.join(home, 'repo')
  fs.mkdirSync(path.join(repo, 'plugins', 'surfcore'), { recursive: true })
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true })
  fs.mkdirSync(path.join(home, 'surfcore'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'config.json'), JSON.stringify({ snowluma: { httpUrl: 'http://127.0.0.1:31000' } }))
  // 用 junction 让 discover 认为 <home>/plugins/surfcore 指向仓库
  try {
    fs.symlinkSync(path.join(repo, 'plugins', 'surfcore'), path.join(home, 'plugins', 'surfcore'), 'junction')
  } catch {
    return // 没权限建链接就跳过这条
  }
  fs.writeFileSync(path.join(home, 'surfcore', 'config.json'), JSON.stringify({ consoleToken: 'console-tok' }))
  const { config, sources } = loadSurfcoreConfig({ env: { DSH_HOME: home }, home })
  assert.equal(config.snowluma.httpUrl, 'http://127.0.0.1:31000')
  assert.equal(config.consoleToken, 'console-tok')
  assert.equal(sources.length, 2)
})

test('gatewayTargets 读到 key 文件；没有 key 也能给出默认地址', () => {
  const home = tempHome()
  fs.mkdirSync(path.join(home, 'openai-gateway'), { recursive: true })
  fs.writeFileSync(path.join(home, 'openai-gateway', 'api-key'), 'sk-local\n')
  const withKey = gatewayTargets({ env: { DSH_HOME: home }, home })
  assert.equal(withKey[0].baseUrl, 'http://127.0.0.1:8326')
  assert.equal(withKey[0].key, 'sk-local')

  const noKeyHome = tempHome()
  const noKey = gatewayTargets({ env: { DSH_HOME: noKeyHome }, home: noKeyHome })
  assert.equal(noKey[0].key, '')
  assert.equal(noKey[0].baseUrl, 'http://127.0.0.1:8326')
})

test('gatewayTargets 认通用的 OPENAI_* 变量，且抹掉地址末尾的 /v1', () => {
  const home = tempHome()
  const targets = gatewayTargets({
    env: { DSH_HOME: home, OPENAI_BASE_URL: 'https://api.example.com/v1/', OPENAI_API_KEY: 'sk-generic' },
    home,
  })
  assert.equal(targets[0].baseUrl, 'https://api.example.com')
  assert.equal(targets[0].key, 'sk-generic')
  assert.equal(targets[0].keySource, '环境变量 OPENAI_API_KEY')
  assert.equal(targets[0].urlSource, '环境变量 OPENAI_BASE_URL')
  // 具体变量优先于通用变量，且默认 8326 始终兜底
  const both = gatewayTargets({
    env: {
      DSH_HOME: home,
      DSH_OPENAI_GATEWAY_API_KEY: 'sk-specific',
      OPENAI_API_KEY: 'sk-generic',
      OPENAI_BASE_URL: 'https://api.example.com/v1',
      DSH_OPENAI_GATEWAY_BASE: 'http://127.0.0.1:9999',
    },
    home,
  })
  assert.deepEqual(
    both.map((item) => item.baseUrl),
    ['http://127.0.0.1:9999', 'https://api.example.com', 'http://127.0.0.1:8326'],
  )
  assert.equal(both[0].key, 'sk-specific')
})