# Petra 发布指南

本文档说明如何构建并发布带 **Tauri updater 签名**的 Petra Release。

> ⚠️ **安全红线**：本文档只写路径与变量名，**绝不写入**真实私钥、密码或公钥内容。
> 私钥文件 **永远不能** 提交到 Git（`.gitignore` 已忽略 `.tauri/` 与 `*.key`）。

---

## 一、开发构建（无需私钥）

普通开发 / 日常构建 **不需要** updater 私钥：

```bash
npm install
npm run tauri dev      # 开发
npm run build          # 前端构建
cd src-tauri && cargo check && cargo test
```

这些命令在没有任何签名环境变量时即可正常运行。

---

## 二、Updater 签名密钥

### 2.1 私钥位置（发布者机器）

```text
%USERPROFILE%\.tauri\Petra\updater.key      # 私钥（带强密码）
%USERPROFILE%\.tauri\Petra\updater.key.pub  # 公钥
```

- 私钥由发布者保管，**绝不入库**，且使用**强密码**保护
- 公钥已写入 `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`
- 当前正式公钥 ID：`86CF5C69AD4F6C19`

### 2.2 环境变量（发布时临时设置）

| 变量 | 作用 |
| -- | -- |
| `TAURI_SIGNING_PRIVATE_KEY` | **私钥文件完整内容**（实测 `tauri build` updater signing 真正生效的变量） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码（若有） |

> ⚠️ **实测结论**：`TAURI_SIGNING_PRIVATE_KEY_PATH`（路径形式）**不能**满足当前 `tauri build` 的 updater signing 需求。
> 必须使用 `TAURI_SIGNING_PRIVATE_KEY`，且其值为私钥文件的**完整内容**（不是路径）。

设置方式（临时，不写入仓库，密码交互输入不回显）：

```powershell
# PowerShell：读取私钥文件内容 + 交互输入密码（不会进入命令历史）
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\Petra\updater.key" -Raw
$sec = Read-Host -AsSecureString "输入 updater 私钥密码"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Net.NetworkCredential]::new('', $sec).Password
Remove-Variable sec
# 构建
npm run tauri build
# 清理
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

---

## 三、生成 updater artifacts（签名 Release 构建）

```bash
# 设置签名环境变量后
npm run tauri build
```

`tauri.conf.json` 已配置 `bundle.createUpdaterArtifacts: true`，构建会产出：

```text
src-tauri/target/release/bundle/nsis/Petra_<版本>_x64-setup.exe        # NSIS 安装包
src-tauri/target/release/bundle/nsis/Petra_<版本>_x64-setup.exe.sig   # updater 签名
src-tauri/target/release/bundle/msi/Petra_<版本>_x64_en-US.msi         # MSI
src-tauri/target/release/bundle/msi/Petra_<版本>_x64_en-US.msi.sig    # updater 签名
```

**canonical updater artifact = NSIS `setup.exe`**（Tauri Windows updater 推荐）。

---

## 四、生成 / 更新 latest.json

`release/latest.json` 是 updater 的元数据文件，指向 GitHub Release：

```json
{
  "version": "0.1.x",
  "notes": "Petra v0.1.x",
  "pub_date": "2026-xx-xxTxx:xx:xxZ",
  "platforms": {
    "windows-x86_64": {
      "signature": "<从 .sig 文件读取的内容>",
      "url": "https://github.com/Wumiu/Petra/releases/latest/download/Petra_0.1.x_x64-setup.exe"
    }
  }
}
```

其中 `signature` 字段 = **`.sig` 文件的完整内容**（base64，非路径）。

### 4.1 Legacy updater 兼容性约束（重要）

> **Petra v0.1.5 legacy updater 固定读取 `platforms["windows-x86_64"]`，
> 且只能直接启动 EXE**（把下载内容保存为 `.exe` 后 `Command::new(path).spawn()`）。

因此在仍需兼容 v0.1.5 的时期：

```text
platforms["windows-x86_64"]      必须指向 NSIS updater（Petra_*_x64-setup.exe）
platforms["windows-x86_64-nsis"] 指向 NSIS（同上，保持一致）
platforms["windows-x86_64-msi"]  指向 MSI（供支持 MSI 的客户端 / 人工安装）
```

- **不要**让 `windows-x86_64` 指向 MSI（Tauri 默认行为）——否则旧客户端会下载 MSI 却当作 EXE 启动而失败
- GitHub Actions workflow 已加入 **normalization 步骤**（`scripts/normalize-updater-metadata.mjs`），
  在 `latest.json` 生成后自动把 `windows-x86_64` 覆盖为 `windows-x86_64-nsis` 的 url/signature，
  永久保证每次发布都满足此约束，无需手工维护

更新后提交 `release/latest.json` 并 push（这是唯一需要入库的更新相关文件）。

### 4.2 Stable channel 约束（重要）

> **Petra updater endpoint 依赖 `releases/latest/download/latest.json`**，
> 即 GitHub 的 **Latest** release 语义。

因此正式可自动更新的版本**必须**：

```text
prerelease = false
```

否则：
- GitHub `releases/latest` 不会指向该版本（Latest 只选"最新的非 prerelease / 非 draft"）
- `releases/latest/download/latest.json` 会 404
- 客户端（v0.1.5 legacy 与 v0.1.6+）都无法发现更新

如果将来需要发布 Beta / RC：
- 应使用**另外的 prerelease channel / 独立 endpoint**
- **不能**复用 stable updater endpoint（会切断 stable 更新链）

### 4.3 Updater 网络约束（v0.1.7 baseline）

> **Petra 从 v0.1.7 起是 updater 网络稳定基线版。**

- **不要**在 updater endpoints 中依赖不可控的免费 GitHub 代理（如已失效的 mirror.ghproxy.com）
  —— 它们 DNS / 可用性不稳定，且会被客户端编译进 endpoint 列表
- Windows updater 应**正确处理系统代理**：客户端通过 `get_system_proxy` 自动发现
  环境变量（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY）与 WinINET 系统代理，覆盖检查和下载
- 客户端 updater 检查设置**有限超时**（约 12s），网络不可达时快速失败而非无限等待
- **发布前必须验证**：
  1. metadata 网络测试（`releases/latest/download/latest.json` 可达）
  2. installer 下载测试
  3. signature 验证测试
- 已装 v0.1.6 且网络受限（无代理、无法访问 GitHub）的用户，需**手动安装 v0.1.7 一次**，
  之后自动更新恢复；不要声称"所有中国大陆网络均可无代理更新"（事实并非如此）

---

## 五、上传 GitHub Release

1. 打 tag：`git tag v0.1.x && git push origin v0.1.x`
2. 创建 GitHub Release（可用 `gh release create` 或网页）
3. 上传资产：
   - `Petra_0.1.x_x64-setup.exe`
   - `Petra_0.1.x_x64-setup.exe.sig`
   - `release/latest.json`（已入库，Release 附件可不重复传）
4. 将 Release 设为 **Latest**（非 prerelease）

> updater 检查的 URL 是 `https://github.com/Wumiu/Petra/releases/latest/download/latest.json`，
> 指向 Release 附件的 `latest.json`。

---

## 六、验证签名

验证 `.sig` 是否与当前 pubkey 匹配（本地）：

```bash
# 方式 1：用 minisign 独立验证（需要 minisign 工具）
minisign -V -P "$(cat %USERPROFILE%\.tauri\Petra\updater.key.pub)" -m <artifact> -x <artifact>.sig

# 方式 2：Tauri signer sign（无 verify 子命令，可用 Rust minisign-verify crate 验证）
```

> 注：Tauri CLI 2.11 无内置 verify 子命令。最可靠的验证是：
> **用 `npm run tauri build` 生成 `.sig` 的过程本身**（若私钥与公钥不匹配，构建会失败）。
> 也可用独立 Rust 程序（`minisign-verify` crate）对 artifact + `.sig` + pubkey 做完整验签。

---

## 七、常见问题

| 问题 | 处理 |
| -- | -- |
| 构建报 `A public key has been found, but no private key` | 未设置签名环境变量；普通开发可忽略，发布必须设置 |
| 构建卡在 `Decrypting updater signing key, expect a prompt for password` | 私钥有密码但未提供 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |
| 用户收不到更新 | 检查 `latest.json` 的 `version` 是否高于用户版本、`url`/`signature` 是否正确 |
| 想重新生成密钥 | 删除 `.tauri/` 后重新 `npx tauri signer generate`，并更新 pubkey 到 tauri.conf.json |

---

## 八、安全清单

- [ ] 私钥只在 `%USERPROFILE%\.tauri\`（或安全位置），**不在仓库**
- [ ] `TAURI_SIGNING_PRIVATE_KEY*` 只作临时环境变量，不写入 `.env` / 代码 / Git
- [ ] `.gitignore` 包含 `.tauri/` 与 `*.key`
- [ ] `latest.json` 的 `signature` 来自真实构建 `.sig`，非手写
