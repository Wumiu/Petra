# dsh-petra-bridge

给 Petra 一个反向入口：Petra 把文字/视频链接 POST 到 dsh，本插件找到当前 dsh 会话，发一轮消息，等助手回复后返回。

## 安装

把整个 `dsh-petra-bridge` 目录放进 dsh profile 的 node_modules，或在 dsh 插件管理器里用本地目录安装。然后在该 profile 的 `package.json` 的 `dsh.profile.bundles` 里加入：

```json
"dsh-petra-bridge"
```

并在 `cordis.patch.yml` 加入：

```yaml
- insert:
    - id: dsh-petra-bridge
      name: dsh-petra-bridge
      config:
        token: ""
```

重启 dsh。

## 请求

```bash
curl -X POST http://127.0.0.1:3080/petra/ask \
  -H 'content-type: application/json' \
  -d '{"text":"看看这个视频并总结","url":"https://example.com/a.mp4"}'
```

返回：

```json
{ "ok": true, "reply": "视频总结……" }
```

如果配置了 `token`，请求要带 `x-petra-token`。

## 说明

- 优先使用请求里的 `sessionId`；没有就选 `sessionPersistence.list()` 里最近的一条会话。
- 通过 `agents.get` / `sessionController.resolveAgent` / `agents.resume` 找 agent。
- 用 `agent.followup()` 发消息，轮询 `session.ownEvents()` 直到 `turn/end`，收集 `assistant/message` 文本。
- 仅在 loopback 上使用；不要把端口暴露到公网。
