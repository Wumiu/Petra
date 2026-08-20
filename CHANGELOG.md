# Changelog

本项目的所有重要变更都会记录在此文件中。

## [Unreleased]

- 重写 README，完善使用说明
- 新增开源许可与致谢、商标与图片版权免责声明

## [v0.1.6] - 2026-08-20

- 自动更新安全迁移：接入 Tauri 官方 updater 插件（内置 minisign 签名验证）
- 移除旧的无验签下载执行链（http_get / http_download / write_update_installer / launch_update_installer）
- 更新 updater 信任链：新的签名密钥对，从 v0.1.6 起更新必须验签
- 新增 GitHub Actions Release workflow（tauri-action 自动签名 + 生成 latest.json）

## [v0.1.5] - 2026-08-20

- 新增自定义更新管理器（多镜像源 + 下载进度），`release/latest.json` 更新清单

## [v0.1.4] - 2026-08-19

- 区域穿透：交互区域改为精确判定（InteractiveRegion 替代整窗透明）
- 信息版：新增信息面板（桌面、天气、待办提醒）
- 修复 showUpdateBubble XSS 漏洞（改 textContent）
- 修复 dev 模式资源路径错误、模型路径候选
- 行为引擎重构：clearTarget 递归 bug 修复、Magic Numbers 提取

## [v0.1.3] - 2026-08-15

- 模型管理：已导入的 PSD 模型现在可在「模型设置」中直接删除
- 安全删除：删除前二次确认；删除当前正在使用的模型时自动回退到内置模型
- 存储安全：Rust 后端限制删除范围，仅允许操作应用数据目录中的已导入 PSD
- 修复：PSD 文件名允许包含点号；导入失败时给出提示并回退内置模型

## [v0.1.2] - 2026-08-15

- 新增动作系统（14 个动作 / 动作池分级）
- BPM 音乐跟随与节拍眨眼
- 拖拽摆动
- 修复动作回落、眨眼镜像、帧率相关阻尼等问题

## [v0.1.1] - 2026-08-13

- 新增检查更新提示：启动自动检查 + 菜单手动检查，点击气泡打开浏览器下载 Release
- README 顶部新增快速获取引导（普通用户走 Releases，开发者走源码）

## [v0.1.0] - 2026-08-13

- 首个版本：Live2D 桌面桌宠（Tauri + Anime2.5DRig PSD 自动装配）
- 行为引擎与交互体验优化
- 修复多项问题并重构核心模块
- 第一轮修复：安全启动应用 / Shell 校验 / 引擎优化
- 第二轮修复：SMTP 授权码加密、反馈邮件直发、清理占位角色残留、音乐摆动标注未完善
- 项目文档与图标更新
