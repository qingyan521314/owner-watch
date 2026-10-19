# 贡献指南 / Contributing

## 提交前检查

```bash
node selftest.mjs        # 全部通过（宿主目录内 42 项，独立目录 37 项）
node --check index.js    # 语法检查
```

`selftest.mjs` 中的每条断言对应一个已修复的缺陷。若认为某条断言本身有误，请在 Pull Request 中说明理由，不要直接修改断言使其通过。

## 代码约束

以下七条为硬性要求：

1. **无第三方依赖**：不得新增 `package.json` 依赖，仅使用 Node.js 标准库。
2. **不执行外部命令**：禁止使用 `child_process`、`spawn`、`exec`、`eval`、`Function`。
3. **仅读取文件属性**：扫描 `skills/`、`plugins/`、`src/` 时只读取 `stat` 信息。
   唯一例外是 `data/config.json`（用于计算哈希），不得扩展至其他文件。
4. **仅写入自身目录**：所有写操作必须位于 `data/owner-watch/` 下。
5. **不发起网络请求**：除宿主本机 OneBot 通道外，禁止任何网络访问，禁止遥测。
6. **不产生 token 消耗**：不得在插件中调用模型，通知文案必须由本地模板生成。
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
