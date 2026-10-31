# dsh-qq-zone

给 DSH 里的 QQ 机器人补两条能力：**发 QQ 空间**（说说 / 看图 / 点赞 / 评论 / 删）和**识图**（把图片交给视觉模型，或退回系统 OCR 读字）。

两条链路都复用你机器上已经有的东西，**不需要再申请任何 key**：

| 能力 | 后端 | 说明 |
| --- | --- | --- |
| QQ 空间 | SnowLuma 的 OneBot `qzone_*` 接口（默认 `127.0.0.1:3000`） | 用的是机器人自己登录的那个 QQ |
| 识图 | DSH 本地 OpenAI 兼容网关（默认 `127.0.0.1:8326`）里的多模态模型 | 网关会把 DSH 里所有可用 provider 聚成一个出口 |
| 兜底 OCR | Windows 自带 WinRT OCR（`Windows.Media.Ocr`） | 视觉模型不可用时至少把图里的字读出来 |

## 安装

```powershell
dsh plugin --profile desktop install github:LFELKEEA/dsh-qq-zone
```

或者本地开发时，把仓库链接进 profile（跟 dsh-peak-valley 一样的做法）：

```powershell
mklink /J "$env:USERPROFILE\.dsh\plugins\dsh-qq-zone" "D:\path\to\dsh-qq-zone"
```

然后在 `~/.dsh/profiles/<profile>/package.json` 里加依赖与 bundle，重启 DSH。

## 工具

| 工具 | 用途 |
| --- | --- |
| `qzone_publish` | 发说说。`content` 必填；`images` 可传本地路径 / http(s) / `base64://` / `data:`；`permission` 默认 `public`，可选 `friends` / `private`（仅自己）/ `some`（配 `targetUins`）/ `hide` |
| `qzone_timeline` | 看空间：`source=mine`（默认，我发的）或 `source=feeds`（好友动态），带 `tid` 方便后续操作 |
| `qzone_delete` | 删一条自己的说说（要 `tid`） |
| `qzone_like` | 点赞 / 取消赞；好友的说说建议同时给 `targetUin` 与 `abstime` |
| `qzone_comment` | 评论说说（纯文字） |
| `qzone_profile` | 读 / 改空间昵称与签名（`mode=get|set`） |
| `see_image` | 看图：给本地路径 / http(s) / `data:` / `base64://` / `sha256:` 附件 id，或直接给 QQ 消息 `messageId`；`mode=describe`（默认，理解画面+读字）或 `mode=ocr`（只认字） |
| `vision_status` | 诊断：本地网关通不通、有多少个能看图的模型、OCR 兜底可不可用 |

## 通常不用配置

顺序是「环境变量 → SurfCore 配置 → 已知位置 → 默认值」：

- OneBot 端点：`QZONE_ONEBOT_HTTP` / `QZONE_ONEBOT_TOKEN` → SurfCore `config.json` 的 `snowluma.httpUrl` 与 `accessToken`（也会读 `~/.dsh/surfcore/config.json`）→ `http://127.0.0.1:3000`
- 视觉网关：`DSH_OPENAI_GATEWAY_BASE` / `DSH_OPENAI_GATEWAY_PORT` / `DSH_OPENAI_GATEWAY_API_KEY` → `~/.dsh/openai-gateway/api-key` → `http://127.0.0.1:8326`
- SurfCore 配置不在默认位置时：`SURFCORE_CONFIG=<路径>`

## 环境要求

- Windows（只有 OCR 兜底依赖系统；其余平台也能跑，只是没有 OCR）
- DSH `>=0.2.0-rc.1 <0.3.0 || >=0.2.1-rc.1 <0.3.0`
- SnowLuma 2.2+ 且已登录 QQ（`qzone_*` 是它提供的动作）
- 想用识图：DSH 里至少有一个支持图片输入的模型（`vision_status` 会告诉你有没有）

## 在 QQ 会话里用它

DSH 的 QQ 对话 preset 带了一个工具白名单守卫（`surfcore/qq-tool-restrict.mjs`），
不在名单里的工具**注册得进来、执行会被拒**。要用本插件的工具，需要把名字加进那份
`SAFE_EXACT`（显式名字，不要用前缀通配）：

```
qzone_publish qzone_timeline qzone_delete qzone_like qzone_comment qzone_profile see_image vision_status
```

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| `onebot-unreachable` | SnowLuma 没跑 / QQ 掉线 / 端口不是 3000。`vision_status` 与 `GET http://127.0.0.1:3000/get_login_info` 都能验证 |
| `onebot-unauthorized` | 令牌不对，或连到了别的账号（机器人号 / 个人号端口不同） |
| `onebot-action-missing` | SnowLuma 太老，没有 `qzone_*` 动作 |
| `onebot-rejected` + retcode | QQ 侧拒绝：空间没开通、没有权限、内容被风控 |
| `no-vision-model` | 本地网关里没有能看图的模型：装一个视觉 provider，或只用 `mode=ocr` |
| `vision-backend-unavailable` | 网关没起来（DSH 关掉它就没了），或模型上游报错 |
| OCR 读不出字 | 图里确实没字，或系统缺中文 OCR 语言包 |

## 测试

```powershell
npm test
```

零运行时依赖；测试覆盖发现逻辑、OneBot 错误映射、图片输入（路径 / data URL / base64 / `file:///` / sha256 附件）、视觉模型挑选与降级、工具注册与参数校验。

## 许可

MIT

## 相关

- [dsh-peak-valley](https://github.com/LFELKEEA/dsh-peak-valley) —— 峰谷时段自动启停 QQ 机器人
- [dsh-default-model](https://github.com/LFELKEEA/dsh-default-model) —— 固定 DSH 默认模型