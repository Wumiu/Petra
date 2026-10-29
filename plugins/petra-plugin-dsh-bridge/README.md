# DSH Bridge（Petra 插件）

把 Petra 收到的文字或视频链接转给 dsh，让 dsh 的模型/插件处理，再把结果说出来。

## 依赖

1. dsh 侧安装 `dsh-petra-bridge`，并启用 `/petra/ask` 路由。
2. 在 Petra 控制面板 →「插件」安装本插件。
3. 打开插件设置，填：
   - 反向桥地址：`http://127.0.0.1:3080/petra/ask`（按 dsh 实际端口改）
   - token：与 dsh-petra-bridge 配置一致
   - session ID：可选，留空让 dsh 选最近会话

## 用法

对 Petra 说：

> 把这个视频链接发给 dsh 看看：https://...

Petra 的模型会调用 `ask_dsh`，dsh 处理完后 Petra 用气泡/语音播报结果。

如果 dsh 没开、没有会话或 token 不匹配，工具会返回明确错误，不会静默。
