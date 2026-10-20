# 贡献指南 / Contributing

## 提交前检查

```bash
node selftest.mjs        # 全部通过（宿主目录内 80 项，独立目录 74 项）
node --check index.js    # 语法检查
```

`selftest.mjs` 中的每条断言对应一个已修复的缺陷。若认为某条断言本身有误，请在 Pull Request 中说明理由，不要直接修改断言使其通过。

## 代码约束

以下七条为硬性要求：

1. **无第三方依赖**：不得新增 `package.json` 依赖，仅使用 Node.js 标准库。
2. **不执行外部命令**：禁止使用 `child_process`、`spawn`、`exec`、`eval`、`Function`。
3. **内容读取严格受限**：扫描 `skills/`、`plugins/`、`src/` 时默认只读取 `stat` 信息；
   仅当检测到变更、且 `detailEnabled` 开启时，才读取发生变化的文本文件（≤ 256 KB、
   不含二进制特征）做行级 diff，并把副本留在 `data/owner-watch/contents/`。
   二进制与超大文件不得读取内容，被监听范围之外的任何文件不得读取。
4. **仅写入自身目录**：所有写操作必须位于 `data/owner-watch/` 下。
5. **网络访问受限**：除宿主本机 OneBot 通道与宿主提供的模型接口（`api.fetch`）外，禁止任何网络访问，禁止遥测。
6. **模型调用仅用于生成通知文本**：必须由 `useModel` 开关控制、必须保留模板兜底、必须经 `sanitizeNotice` 校验；不得把模型用于其他用途。发送给模型的仅限变更摘要（行级 diff 的增删行数、关键行、清单文件的名称/描述/能力、代码文件的开头注释）、文件名与角色设定，不得发送完整文件内容或聊天内容。
7. **不修改宿主核心代码**：仅可调用插件 API（`setup`、`activate`、`deactivate`、`hooks`、`providers`）。

上述七条同时构成 `DISCLAIMER.md` 中"明确不具备的能力"的依据。任一条被违反，免责边界即不成立，相关 Pull Request 不予合并。

## 提交信息规范

采用 Conventional Commits 格式，说明变更原因：

```
fix: 冷却期内再次变更时待发队列被覆盖
feat: 支持按扩展名排除
docs: 补充 LICENSE 说明
test: 自测在独立目录可运行
```

## 贡献者声明（DCO）

提交 Pull Request 即表示确认：

1. 该改动为原创，或已获得按本仓库许可（MIT）提交的授权；
2. 同意该贡献以 MIT 许可证发布；
3. 未引入第三方专有代码、密钥、内部路径或个人信息。

## 不应提交的内容

- `data/` 目录、日志、包含 QQ 号或聊天内容的截图
- API Key、Cookie、Token、绝对路径
- 与本插件职责无关的功能

## 功能边界

本插件仅负责检测与通知，不执行任何动作：不自动重启、不自动重载、不修改文件。
将其扩展为自动修改文件或自动重启宿主，会超出 `DISCLAIMER.md` 定义的能力边界，此类功能不予接受。
