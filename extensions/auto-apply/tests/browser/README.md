# 插件合成浏览器回归

在仓库根目录运行（PowerShell）：

```powershell
# 前提：仓库开发依赖已安装，含 playwright 或 @playwright/test。
# 仅安装此目录锁定的 antd / React / dayjs 夹具依赖，不改生产依赖。
npm ci --prefix extensions/auto-apply/tests/browser --ignore-scripts --no-audit --no-fund
npx playwright install chromium

$env:OJAF_EVIDENCE_DIR = Join-Path (Get-Location) '.tmp/ats-review-fixes/evidence'
node extensions/auto-apply/tests/browser/verify.mjs
# 只跑负向回归，不执行 antd 正常填写：
node extensions/auto-apply/tests/browser/verify.mjs --scenario negative
# 现有正常路径可定向选择，逗号分隔：
node extensions/auto-apply/tests/browser/verify.mjs --scenario dates,repeat,labels,selectRadio,addBlocks,safety
node --test extensions/auto-apply/tests/content.test.cjs
```

默认 headless Chromium；`--headed` 可显示窗口。断言失败返回非零退出码。
负向夹具覆盖显式/默认 submit、嵌套伪按钮、危险祖先、导航链接、原生 form submit 计数，
以及 aria-invalid、blur 改值、区间关闭延迟清空后的标记、逐项结果及 filled/failed/pending 统计。
原生 submit 计数通过显式点击陷阱校准一次，重置后才运行插件。

验证边界：仅本机合成 Web 页面。正常夹具使用真实 antd 控件；负向夹具使用可控 DOM 模拟拒绝/关闭行为。
本测试不连接真实 ATS，不证明真实 ATS 或 Windows Electron 验收通过。运行时 stub 禁用 AI，使用合成 sample-profile。
负向计划直接调用 content 内部 applyAutofillPlan，以确定性触发审计；正常夹具通过扩展消息入口执行完整本地填写。

证据写入 `OJAF_EVIDENCE_DIR`；未设置时默认为 `tests/browser/evidence/`。
`assertions.json` 包含逐项 PASS/FAIL 与负向实测快照；正常路径额外生成 `fill-result.json`、
`debug-snapshot.json` 和 `after-fill.png`。`.chromium-profile/` 为本测试独立浏览器数据，勿复用个人浏览器目录。
负向单跑仅生成断言文件；复跑建议使用新的任务证据子目录，避免误认旧正常路径产物。
