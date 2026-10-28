# 结构化模块简历工作台实施合同提案（RESUME-BUILDER 前置）

> **状态：关键产品方案已批准（2026-10-29，基线 main @ `82287b05`，v2 修订）。** Owner 在主协调聊天确认采用 `@dnd-kit` 拖拽、DOCX 可编辑导出、篇幅软目标及本期条目级导入排除；AI 改写与粘贴导入后续再做。此批准对应 D2、D3、D5、D6，不等于批准其余待决项或证明分页技术方案可行。**不代表已实现、集成或验收**，不授权提交、合并、真实库迁移、真实数据操作或部署；依赖尚未安装，实施时核对官方版本与兼容性并锁定版本。
>
> 依据：`wiki/P1_FEATURES.json`、`wiki/P1_IMPLEMENTATION.md`（RESUME-BUILDER 节）、`wiki/CAREER_SCHEMA_CONTRACT_PROPOSAL.md`（职业资料冻结合同）及基线源码只读核查。本仓库无 `.codegraph`。

**标注约定**

- 【已有事实】：代码、Migration、备份或 wiki 中已存在并核实的内容，施工必须遵守。
- 【建议方案】：本文档提出的待冻结方案，含具体字段、规则与实现建议。
- 【不变量】：方案内的技术必须项（校验顺序、幂等规则、匹配键等），由实施者按此实现，不构成用户决策项。
- 【待决策 D#】：必须由 Owner 拍板的问题，附推荐与理由。**未决事项一律保持提案状态**：不依赖其结论的设计与核查可继续推进；依赖其结论的实施在 Owner 冻结前不动工。本文档不自行宣布冻结。

## 0. 目的与范围

回答八个问题：

1. 现有 Resume Variant/Version、Career Material、导入、绑定、预览、导出哪些可直接复用，哪些是真实缺口（§1、§2）。
2. Section/Bullet 结构化数据、素材来源、版本局部改写、排序/隐藏、"移除版本不删素材"的规则合同（§3）。
3. 固定两栏工作台（左素材库 / 右编辑+实时预览 / 顶部统一控制）的合同（§4）。
4. 导入支持格式与解析失败/不确定内容的校对流程（§5）。
5. 岗位版本、Diff/回退、来源追溯、旧版本保护，与 Attempt 绑定/冻结合同的兼容（§6）。
6. 一页/两页目标、溢出提示、稳定分页、PDF 与可编辑文档导出的具体可行方案；区分已有能力与待验证方案（§7）。
7. 持久化、备份兼容、AI 调用边界、将来要触及的共享文件与依赖（§8）。
8. 按用户可用成果划分的实施顺序、验收条件与 Owner 决策项（§9、§10）。

非目标：不实现代码；不扩展 Deep Match 或 Agent 工具；不规划其他 P1 工作包；不做像素级 UI 规范。

## 1. 现状证据核对（【已有事实】）

### 1.1 数据模型（`prisma/schema.prisma`）

- `ResumeVariant`（`:1526`）：userId scope；`name`、`targetJobOpportunityId → JobOpportunity SetNull`、`currentVersionId`、`archivedAt`。
- `ResumeVariantVersion`（`:1548`）：`versionNumber`（`@@unique([resumeVariantId, versionNumber])`）、`parentVersionId` 自链、`status`（DRAFT 可变；FROZEN/SUBMITTED/ARCHIVED 不可变，服务层强制，注释明示非 DB trigger）、`targetJdVersionId`、`sourceMatchAnalysisId`、`locale`、`headerSnapshot String?`、`layoutConfig String?`、`createdVia`、`frozenAt`、AI 绑定三列（`managedAiProvenance`/`resolvedConnectionId`/`resolvedModel`）。
- `ResumeVariantSection`（`:1585`）：`title`、`systemKind String?`、`sortOrder`，Cascade 于版本。
- `ResumeVariantSectionItem`（`:1598`）：`careerMaterialItemId → CareerMaterialItem Restrict`、`materialTitleSnapshot`（插入时快照）、`itemKind`、`sortOrder`。
- `ResumeExpression`（`:1613`）：`kind`、`content`、`sortOrder`、`evidenceStatus`（UNLINKED/LINKED）。
- `ResumeExpressionEvidence`（`:1633`）：表达式→CareerEvidence 溯源链接，落 `evidenceContentSnapshot`/`evidenceHashSnapshot`/`evidenceUpdatedAtSnapshot` 三快照（注释：后续素材编辑不得改写冻结简历语义）。
- `ResumeArtifact`（`:1651`）：`kind`/`format`/`storageKey`/`fileName`/`sha256`/`byteSize`；storageKey 为逻辑键（注释：永不存 Windows 绝对路径）。
- `ResumeImportAttempt`（`:1678`）：durable 导入幂等身份 PENDING→RUNNING→EXECUTED|FAILED→CONFIRMED；客户端预铸 `requestId` 同时充当 ResumeVariant.id；**只存 receipt 不存解析载荷**（代码注释：hosted ledger replays receipts rather than payloads），`INTENTIONALLY_EXCLUDED` 不备份。
- `ApplicationAttempt`（`:938`）：`submittedResumeVersionId`/`submittedResumeArtifactId`/`submittedAgainstJdVersionId` 三溯源列，均 Restrict。
- `MatchAnalysis.resumeVariantVersionId`（`:1705`）：注释冻结——FAST_SCREENING 必须为空、DEEP_MATCH 必须非空，服务层强制。
- 常量：`resumeVariantConstants.ts` 定义 `RESUME_SECTION_SYSTEM_KIND`（SUMMARY/EXPERIENCE/EDUCATION/SKILLS/PROJECTS/CUSTOM 6 值）、`RESUME_SECTION_ITEM_KIND`（13 种素材类型 + SUMMARY + MANUAL）、`RESUME_EXPRESSION_KIND`（BODY/BULLET/HEADLINE）。

### 1.2 服务、Action 与 UI

- `resumeVariantService.ts`（1177 行）：Variant CRUD/归档、版本列表、`getVersion` 全图读取、`updateDraft`/`updateHeaderSnapshot`、`freeze`、`markSubmittedInTransaction`、`createBlankDraft`（单可编辑草稿不变量 + versionNumber 冲突重试）、`cloneAsDraft`/`copyVersionGraph`（整图深拷贝——**生成全新行 ID**，含 evidenceLinks 快照与 `parentVersionId` 链）、Section/Item/Expression 全套 CRUD + 全序 `reorder*`；统一并发闸门 `guardDraftMutationInTransaction`（DRAFT + 未归档 + `submittedAttempts: none` 的 CAS 写锁）；`isSubmittedReference` 保护被 Attempt 引用的版本；`requireOwnedActiveMaterial` 拒绝归档素材；同 section 素材去重 `MATERIAL_ALREADY_IN_SECTION`。
- `resumeVariantWriteBoundary.ts`：版本写白名单仅 `resumeVariantService.ts` 与 `migrator.ts`，有静态扫描测试。
- `resumeProvenanceService.ts`：表达式↔素材证据 链接/解链/整组替换，写三快照并同步 `evidenceStatus`。
- `resumeVariant.actions.ts`：上述全部能力的 Server Action 面 + `listResumeCareerMaterials`（返回 id/title/type/evidence{id,kind,content}）。
- `ResumeVariantWorkspace.tsx`：单栏编辑器——头部快照表单、Section/Item/Expression 增删改、move up/down 排序、素材选择 Dialog、证据链接 Dialog、预览开关（`ResumePreview` 只读组件）、冻结确认、`ResumeExportControl`。
- `ResumeVariantList.tsx` + `/dashboard/profile/resumes` 页面：创建/改名/归档/列表 + `CanonicalResumeImport` 入口；`[variantId]?version=` 深链经 `resolveResumeVariantWorkspaceVersion` 严格解析（fail-closed 404）。

### 1.3 导入链路（canonical）

- `POST /api/profile/resume-import`（`route.ts`）：multipart 上传或 JSON confirm 同一入口；MIME 白名单 + `sniffFileType` magic bytes 双检（PDF `%PDF`、DOCX `PK`）；5MB 上限（`APP_CONSTANTS.MAX_RESUME_FILE_SIZE_BYTES`）；字节驻留内存不落盘。
- `extract-text.ts`：PDF 走 `unpdf`（≤5 页、≤50k 字）、DOCX 走 `mammoth`（解压炸弹预检：≤1000 entries、≤100MB 解压后）；超时、ENCRYPTED、NO_TEXT、DECOMPRESSION_BOMB 等错误码齐备。
- `resumeImportContract.ts`：`ParsedResumeImportSchema`（zod strict）+ `validateResumeImport` **逐字段原文校验**：所有非空字段必须是 sourceText 的精确连续子串、item expressions 按序覆盖 item.sourceText、section+item+profile 拼接须覆盖全篇（IMPORT_SOURCE_ORDER / IMPORT_EXPRESSION_INCOMPLETE / IMPORT_SOURCE_INCOMPLETE）——AI 推断无法通过校验。
- `resumeImportAttempt.ts`：durable 幂等——请求前落行、`requestSha` 一致性守卫、Managed 绑定先于首次调用、EXECUTED 结果缓存重放、仅可证明已结算的失败才轮转 `executionSeq`（防双重计费）。
- `resumeImportApproval.ts`：**HMAC 签名令牌内嵌完整 `parsed` 结果** + userId/name/rawText/resolvedConnection/Model/managedAiProvenance/requestId/expiresAt（30 分钟，进程内存密钥，重启即失效，不落 staging 表）——confirm 时解析结果来自签名令牌本身，防篡改。
- `canonicalResumeImport.ts`：`inspectResumeImport` 预检（profile 字段冲突 + 素材复用数）；`persistResumeImport`：**confirm 路径先对签名内完整结果重跑 `validateResumeImport`（`:80`）**，再单事务写入——CandidateProfile 仅补空字段、素材按 type+title+sourceText+全字段去重复用、Evidence 按内容+kind 复用、构建 Section(CUSTOM)/Item/Expression(全 BODY)/EvidenceLink 快照/headerSnapshot；`origin:"IMPORT"`、`verificationStatus:"USER_CONFIRMED"`；幂等：`resumeVariant.findFirst({id: requestId})` 已存在即原样返回（`:90`），并发竞态由 `:146` 兜底。
- `CanonicalResumeImport.tsx`：选择文件→`requestId` 预铸→上传→预览（summary/conflicts/profile/逐 item sourceText+structuredFields+expressions+evidenceCandidates+uncertainty+原文）→确认跳转工作台；错误分类区分文件问题与 AI 环境问题。

### 1.4 绑定、冻结与投递溯源

- `applicationService.writeSubmissionInTransaction`（`:143-239`）：不可变首绑定——已绑定值再次提交冲突即 `SUBMITTED_RESUME_PROVENANCE`/`SUBMISSION_PROVENANCE_CONFLICT`；artifact↔version 一致性校验；首次绑定触发 `markSubmittedInTransaction`；初次提交另要求 full AB 能力 + DRAFT/ACTIVE 前置。
- `SubmitResumePicker`/`SubmittedResumePanel`/`ApplicationResumeBindingPanel`：职位详情内按 Attempt 绑定/查看版本（DRAFT 可绑并附警告）；`JobDetails.tsx` 用 `isRestrictedResumeBindingSurfaceEnabled`（resume_v1 且非 full）控制受限面板；full 模式经 `ApplicationTimelineTab` 渲染 `submittedResume` DTO（title+versionNumber+variantId+versionId 深链）。
- 旧 Legacy `Job.resumeId` 拒绝映射到新版本（`assertNoLegacyResumeBinding`，LEGACY_RESUME_UNSUPPORTED，不静默降级）。

### 1.5 预览与导出

- `/resume-print/[versionId]`：独立打印路由，`assertResumeV1Readable` + 所有权 + 仅 FROZEN/SUBMITTED；复用 `ResumePreview print` 模式；`print.css` 定 A4 portrait、15mm 页边距、`break-inside: avoid`（item）、`break-after: avoid`（h3）；`ResumePrintReady` 在 `document.fonts.ready` 后写就绪标记。
- `desktop/main/resume-print.js`：sandbox 隐藏 BrowserWindow 共享主 session、同源导航封锁、30s 超时、`webContents.printToPDF({pageSize:"A4", preferCSSPageSize:true})`；并发同版本合并；`preload` 暴露 `window.vocatryaResume.printToPDF(versionId)`。
- `ResumeArtifactService`：导出要求 FROZEN/SUBMITTED 且未归档；`%PDF-` 签名 + ≤20MB；`existingExport` 复用（行在但字节缺失时重建）；`pendingExports` 进程内去重；临时文件原子 rename + 失败清理；`openForDownload` 仅 `kind:"EXPORT",format:"PDF"`。
- `ResumeExportControl`：DRAFT 导出先确认冻结→查找可复用 artifact→无则 IPC 渲染→POST 存 artifact→GET 下载；Web 宿主无 bridge 时禁用并提示桌面专属；分阶段进度与错误文案。
- API：`POST /api/profile/resume-artifacts?versionId=`（PDF 字节入库）、`GET /api/profile/resume-artifacts/[artifactId]`（RFC 5987 UTF-8 文件名）。
- `RESUME_EXPORT_CORE_REPORT.md`：Task 04 交付记录（含 12 项桌面人工核对清单）；`wiki/MVP_FEATURES.json` `RM-RESUME`/`RM-BIND` 均 `passes: true`（隔离 Windows Electron 已验收）。

### 1.6 备份、迁移与运行时门

- 备份（当前 V6）：`ordering.ts` 已含全部 7 个简历模型 + INSERT_ORDER 正确拓扑；`DEFERRED_FKS` 处理 `currentVersionId`/`parentVersionId`/`sourceMatchAnalysisId` 环引用；`ResumeVariant` 在 `EMPTINESS_MODELS`；`export.ts` 对 `ResumeArtifact` 归一化 storageKey 并标 `bytesMissing: true`——**PDF 字节不进备份**，恢复后按缺失字节重新导出（`existingExport` 的 ENOENT 分支已支持）；`ResumeImportAttempt` 为 `INTENTIONALLY_EXCLUDED`（易失导入身份，不备份）。
- 运行时门（`capabilities.ts`）：`isResumeV1CapabilityEnabled` = AB_ENABLED + scope `resume_v1|full`；`assertResumeV1Readable/Writable` 是所有服务方法的前置；`isLegacyResumeEditorReadOnly` 在启用后将旧编辑器置只读。
- 读分发（`resumeReadDispatch.ts`）：family ab/legacy/blocked；`readAbResumeVariant` 以 `currentVersionId`（缺省回退最高 versionNumber）产出文本。
- 文本投影（`resumeVariantText.ts`）：header + sections/items/expressions → 纯文本，供 Agent `get_resume`/`review_resume`（`resumeLookup.ts` canonical 分发，只读）与 `fastScreening.buildResumeVersionMaterial` 共用。
- 迁移（`migrator.ts:1300-1409`）：Legacy Resume → Variant + FROZEN v1 快照（`layoutConfig` 写入迁移 provenance JSON——该列目前是**自由 JSON 占位**，无业务消费者）；`LegacyMigrationMap` 幂等。
- 既有 `JobDescriptionVersion`/`JobDescriptionParse`/`MatchAnalysis` 基础设施完整；`RESUME_VERSION_CHANGED` stale 原因已存在。

### 1.7 AI 调用边界

- `AI_ASSIGNMENT_PURPOSES` 含 `RESUME`（`connections.ts:77`）；导入走 `resolveBusinessAIConfig(purpose:"RESUME")` + `executeStructuredForAssignment` + Managed 锁/provenance。
- 提示词边界（`canonicalPrompt.ts`）：import-only、忽略文档内指令、只提取显式事实、字段必须原文子串——"不把 AI 推断当用户事实"已工程化。
- Agent 五工具中 `get_resume`/`review_resume` 只读；`review_resume` 不写 Resume Variant（P1 台账已记）。
- 简历图内容构成：headerSnapshot（fullName/headline/email/phone/address/links，源为 CandidateProfile 非敏感列）+ 素材/证据（standard dataset）——按 Career 合同 §8，敏感对象（证件/证明人/附件/敏感表）构造上不可达。

## 2. 真实缺口清单

| P1 要求 | 现状 | 真实缺口 |
| --- | --- | --- |
| 两栏固定布局 | 单栏编辑器 + 预览开关 | 左栏常驻素材库面板；右栏编辑与实时预览同屏 |
| 拖拽组合/排序 | 服务端全序 reorder 已就绪；前端仅上移/下移按钮 | 无拖拽交互与拖拽库（无 DnD 依赖） |
| 素材模块库 | `listResumeCareerMaterials`（id/title/type/evidence）+ Dialog picker | 常驻面板（分组/搜索/detail 摘要/按条 evidence 拖入） |
| 隐藏/删减 | 仅删除（素材不受损，MANUAL 内容随版本行删除） | 无"保留在版本内但不渲染"的隐藏位 —— **Schema 缺口** |
| 局部改写 | expression.content 可编辑（仅落版本） | 已有；需把规则写成合同（§3） |
| 岗位版本 | Variant 创建时可绑 `targetJobOpportunityId`，列表展示 | 无后续更换 Action/UI；版本级 `targetJdVersionId` 未接线（Deep Match 预留） |
| Diff/回退 | `cloneAsDraft` 整图克隆 + `parentVersionId` 谱系 | 无版本对比投影与 UI；**克隆产生全新行 ID，跨版本行对应无键** —— 需 §6 V3 对应规则 |
| AI 修改→新版本 | provenance 三列、`createdVia`、`sourceMatchAnalysisId` 就位 | 无 AI 改写执行路径（`review_resume` 只读）；`createdVia` 无 AI 值 |
| 模板/篇幅 | `layoutConfig` 自由 JSON 列（仅迁移 provenance） | 无模板选择、页数目标、溢出提示；无校验消费者 |
| 真实分页 | 打印页 `@page` A4 + 断页规则（仅 FROZEN/SUBMITTED） | 编辑器无页线/页数；连续文档几何测量**不能直接复现 `break-inside` 行为** —— 需 §7.2 分片器级方案 |
| PDF 导出 | Electron 隐藏窗 printToPDF→artifact 全链路（已验收） | Web 宿主禁用属设计；无额外缺口 |
| 可编辑文档导出 | 无 | 无 DOCX/HTML 生成；artifact 仅 PDF |
| 导入格式 | PDF + DOCX | 无粘贴文本/图片/OCR；扫描件提示"不支持"（NO_TEXT） |
| 校对流程 | 只读预览（原文+结构化+uncertainty+conflict）+ 整包确认 | 无条目级排除/修正入口；确认后修正依赖素材编辑器 |
| 导入幂等（选择维度） | requestId/variant 行重放已防重复写 | 同 requestId 以**不同排除选择**重复 confirm 时无显式语义 —— 需 §5 I6 不变量 |
| 目标职位更换 | — | 工作台内无绑定/更换入口 |
| 版本 ARCHIVED | 状态值存在且按不可变处理 | 无 UI（建议本轮不做 → D10） |
| `materialTitleSnapshot` | 插入时快照，素材改名不回流 | 有意 provenance 语义；可加可选"刷新标题"（建议项） |
| 表达式 kind | 导入全写 BODY；UI 不区分 kind 渲染 | 播种/AI 场景应用 BULLET/HEADLINE 语义化（建议项） |

## 3. 结构化数据与素材规则合同（对应要求 2）

【已有事实】版本内容完全存于版本图：Section→Item→Expression 均 Cascade 于版本；素材仅以 `ResumeVariantSectionItem.careerMaterialItemId` 链接（Restrict，素材归档不删版本行）；`materialTitleSnapshot` 为插入时快照；ExpressionEvidence 三快照在链接时凝固。

【建议方案】规则集（施工即按此实现/校验）：

- **R1 素材与版本分离**：素材事实的唯一持有者是 `CareerMaterialItem` 族；版本图只存"选择+排序+改写副本"。从版本删除 Section/Item/Expression 只删版本行，**永不触碰素材**（现有级联已保证）。MANUAL item 内容只存于版本，删除即失——删除 MANUAL item 前 UI 须提示与素材条目的差异。
- **R2 隐藏 vs 删减**：建议三级（Section/Item/Expression）各加 `hiddenAt DateTime?`（additive，同 `archivedAt` 惯例）。`hiddenAt != null` 保留在版本图内、编辑器内灰显可恢复；**所有"最终简历投影"消费方过滤隐藏行**：编辑器预览、打印页、`projectResumeVariantText`、agent `get_resume`/`review_resume`、fastScreening 文本、DOCX/PDF 渲染。例外仅一处：经所有者授权的版本 Diff 审计视图（§6 V3）。隐藏不等于删除、不参与篇幅计量。
- **R3 局部改写**：`expression.content`/`headerSnapshot` 改写只落当前版本（DRAFT 原地改、FROZEN+ 经 `editVersion` 克隆新 DRAFT——已有行为）；素材本体修改只在职业资料页进行，不回写版本（快照语义保留）。
- **R4 排序**：复用现有 `reorderSections/reorderSectionItems/reorderExpressions` 全序校验 API；拖拽只是前端手势，落库接口不变。
- **R5 素材入库（拖入）**：新服务方法 `attachMaterialToSection`（事务内）：校验素材归属/未归档 + 本 section 去重 → `createSectionItem`（materialTitleSnapshot=item.title，itemKind=素材 type 或 CUSTOM）→ 该素材每条未归档 evidence 播种一条 `kind:"BULLET"` 的 expression + `ResumeExpressionEvidence` 快照链接（`evidenceStatus:"LINKED"`）；无 evidence 的素材入库为空 item，提示用户补要点。
- **R6 单条要点入库**：新方法 `addEvidenceAsExpression(itemId, evidenceId)`：向既有 item 追加 BULLET 表达式 + evidence 快照链接；用于左栏按条拖拽。item 无素材关联时禁止（与证据面板现状一致）。
- **R7 Section 语义**：`systemKind` 仅作模板渲染/建议归类的提示位，标题永远存用户原文；UI 按标题建议 systemKind，导入维持 `CUSTOM`（现状）。同类 systemKind 可在多 section 出现（不强制唯一）。
- **R8 重复与跨节**：同一素材可进入不同 section（不同剪裁语境），同一 section 内不重复（现有 `MATERIAL_ALREADY_IN_SECTION` 保留）。
- **R9 快照刷新**：`materialTitleSnapshot` 保持快照语义；建议提供可选"同步素材标题"操作（写当前素材 title 到 snapshot），列 D7 待决策。

## 4. 固定两栏工作台合同（对应要求 3）

【建议方案】信息架构（沿用 P1 冻结表）：

- **顶部控制条**（单行可换行）：版本切换（`listVariantVersions` + `?version=` 深链）/新建草稿（`createBlankDraft`、`cloneAsDraft`）；目标职位绑定（新 `updateResumeVariantTargetJob` + JobOpportunity 选择器，仅未归档 Variant 可改；不影响版本图）；模板（`layoutConfig.template`，v1 白名单仅 `standard`）；篇幅（`layoutConfig.pageTarget`，1|2）；导出（`ResumeExportControl` 扩 DOCX）；冻结/克隆入口与状态标签（现状语义保留）。
- **左栏·素材模块库**（新 `MaterialLibraryPanel`）：按 `MATERIAL_TYPE_ORDER` 分组 + 搜索过滤；每卡显示 title/type/detail 摘要（新增 list DTO 字段）/evidence 计数，展开可见逐条 evidence；拖拽整卡=§3 R5，拖拽单条 evidence=§3 R6；归档素材不出现（现有 `archivedAt` 过滤）；提供"管理素材"链接到职业资料页（复用现状）。
- **右栏·编辑与实时预览**：编辑模式保留现有 Section/Item/Expression 编辑能力并增加拖拽手柄与隐藏开关；预览始终与编辑同屏（替换当前 preview 开关为分栏），内容即 §7 分页预览组件；只读/冻结态全栏只读 + 克隆新草稿按钮（现状语义）。
- **状态与并发**：沿用 `editable` 判定（DRAFT+未归档+未被 Attempt 引用）与服务端 `guardDraftMutationInTransaction`；乐观 UI 仅用于拖拽重排，失败回滚（reorder 已全序校验）。

【建议方案】拖拽实现：**推荐 `@dnd-kit/core` + `@dnd-kit/sortable`（+`utilities`）**——支持跨容器拖拽（素材→section、条间排序）、键盘可及性好、React 19 兼容；**新依赖仅提案不安装**，批准后由指定 Owner 执行 `npm add`（需核对发布日期与版本固定）。备选：HTML5 原生 DnD（零依赖但跨容器/可及性成本高）。详见 §10 D2。

## 5. 导入与校对合同（对应要求 4）

【已有事实】支持 PDF/DOCX；AI 结构化解析经 durable attempt 幂等；**confirm 路径对签名令牌内的完整解析结果重跑 `validateResumeImport` 原文逐字校验**；预览含原文、结构化字段、evidenceCandidates、conflicts、`uncertainty` 文本；确认一次性写入并以 `requestId`（=variant id）幂等重放；素材按全字段去重复用。

【建议方案】合同化规则：

- **I1 支持格式**：本期 = PDF + DOCX（现状）。不支持扫描件/图片（NO_TEXT 已有文案）、txt、粘贴文本；粘贴文本是否纳入 → D6 待决策（技术上可直接走同一条 extract→preprocess→durable import 管道，rawText 即粘贴内容）。
- **I2 解析失败处理**：错误分类维持现状（文件问题 UNSUPPORTED_FORMAT/NO_TEXT/ENCRYPTED/DECOMPRESSION_BOMB/TOO_LONG 与 AI 环境 AI_UNAVAILABLE/AI_NOT_CONFIGURED 分流）；`validateResumeImport` 校验失败整体拒绝（AI_PARSE_FAILED），不落半成品——该硬边界不改。
- **I3 校对流程**：预览页保持"原文对照 + 整包确认"主路径；**本期新增条目级"排除"**（勾选不导入的 item——被排除内容不创建素材、不进版本图；本期交付范围见 §9 T5）。`uncertainty` 非空条目在预览中置顶标记；确认后修正走素材编辑器（已有详情字段白名单）与版本内改写（R3）。
- **I4 确认语义**：当前确认即写 `verificationStatus:"USER_CONFIRMED"`（preview-confirm = 用户已核对）。不引入"导入待确认"中间态（预览即校对动作；第三态需新工作流且收益小）。
- **I5 排除提交的服务端合同（不变量）**：原文覆盖校验要求结构化结果**完整覆盖** sourceText，因此排除**绝不能作用于校验对象**，只能作用于持久化子集。固定两步顺序：
  1. **先校验完整签名结果**：`readImportApproval` 解出签名内 `parsed` → `validateResumeImport(parsed, rawText)`（即 `persistResumeImport:80` 现状，行为不变）；
  2. **再校验排除选择并构造持久化子集**：
     - **条目标识**：`inspect`/`preview` 响应为每个可排除 item 生成稳定标识 `previewRef = "s{i}.it{j}"`（在**签名解析结果**中的 section/item 位置索引——parsed 冻结在令牌内，索引因此稳定）；confirm 载荷扩展为 `{approval, excludedItemRefs: string[], excludeProfileImport: boolean}`。
     - **选择校验**：每个 ref 过格式白名单（`/^s\d+\.it\d+$/`）+ 越界检查（必须指向 parsed 中真实存在的 item）+ 去重；任一非法整体拒绝 `IMPORT_EXCLUSION_INVALID`，不进入持久化。
     - **子集语义**：被排除 item 不创建素材/复用、不进版本图、其 evidenceCandidates 一并跳过；某 section 全部 item 被排除时该 section 一并跳过（不建空节）；`excludeProfileImport` 为真时跳过 CandidateProfile 补写（**不支持逐字段排除**——profile 字段事后可在资料页改）。
     - **全部排除**：剩余 item 数 = 0 时拒绝确认（`IMPORT_EXCLUSION_EMPTY`）——等价于取消，用户已有显式取消路径。
- **I6 选择维度的幂等与重放（不变量）**：现有 requestId 重放只保证"不重复写"，未定义"选择变化"语义。补齐：
  - **选择签名落账**：首次 confirm 成功时，将 `confirmedSelectionSha = sha256(canonical({excludedItemRefs 排序后, excludeProfileImport}))` 连同结果写入 `ResumeImportAttempt` 行（新增 `confirmedSelectionSha String?` 列——该表 `INTENTIONALLY_EXCLUDED` 不备份，加列无备份影响；随 §8.1 同一条增量 Migration）。
  - **重放判定**（现有 `findFirst({id: requestId})` 命中后增加一步比对）：
    - 请求选择签名 == 已存签名 → 返回同一 variant，不重复写；
    - 签名不一致 → 拒绝 `IMPORT_CONFIRMATION_IMMUTABLE`，提示该导入已按原选择确认，须以新 requestId 重新导入——**不允许在已确认 attempt 上悄悄换结果**；
    - 已存 variant 但无签名（本特性之前的存量导入行）→ 仅允许默认空选择重放，非空选择拒绝。
  - **EXECUTED 未 CONFIRMED** 的重试：允许携带（可不同的）选择再次 confirm——首次成功落库前的选择不构成承诺。
  - **安全边界保留**：approval 令牌签名（含完整 parsed + provenance）、`requestSha` 一致性守卫、`executionSeq` 只在已结算失败时轮转、令牌 30 分钟过期，全部不因排除而放松。

## 6. 岗位版本、Diff/回退与绑定合同（对应要求 5）

【已有事实】DRAFT/FROZEN/SUBMITTED/ARCHIVED 状态机 + `frozenAt`；`parentVersionId` 谱系；`createdVia`（USER/IMPORT/LEGACY_BACKFILL）；submitted 引用永久防改写（应用层 + Restrict FK 双保险）；Attempt 不可变首绑定；`?version=` 深链。`cloneAsDraft`/`copyVersionGraph` **为每行生成新 ID**——跨版本不能按主键对应。

【建议方案】

- **V1 岗位版本**：`ResumeVariant.targetJobOpportunityId` 为岗位绑定宿主（一对 Variant↔JobOpportunity 可空关系已成立）。新增 `updateResumeVariantTargetJob(variantId, jobId|null)`（复用 `requireOwnedVariant`/`requireOwnedTargetJob`/`assertNotArchived`），顶部控制条提供选择器；绑定变更不影响任何版本图。每岗位多版本 = 现有 versionNumber 序列；不同岗位版本 = 不同 Variant（或同 Variant 换绑——产品现状允许，不加硬约束）。
- **V2 版本级 JD**：`targetJdVersionId`/`sourceMatchAnalysisId` 本期**不接线**（Deep Match 前置产物，避免写空语义列）→ D10 记录。
- **V3 Diff**：新只读服务 `resumeVersionDiff.ts`：输入两个 versionId（同 Variant、同用户），输出结构化差异——header 字段、sections（增删/标题改/排序变）、items（增删/materialId/kind/snapshot 改）、expressions（增删/内容改/排序变/hidden 变/evidence 链接变）、layoutConfig 差异。
  - **跨版本对应规则（不变量）**：克隆生成新 ID，需显式对应键。建议为 `ResumeVariantSection`/`ResumeVariantSectionItem`/`ResumeExpression` 各加 **`originRefId String?`**——行创建时自赋 UUID，`copyVersionGraph` 克隆时**原样保留**（additive、无 FK、不进 idmap；与 hiddenAt 同一条增量 Migration）。Diff 主匹配键 = `originRefId`。
  - **存量行回退匹配**（originRefId 为 NULL，如迁移产物/特性前创建的行）：Section 键 = `systemKind ?? 规范化 title`；Item 键 = `careerMaterialItemId`，MANUAL 行 = `itemKind + 内容指纹`（规范化 expressions 拼接的 sha）；Expression 键 = 已链接证据 `careerEvidenceId` 否则 `kind + 规范化 content`。同键多行（如同一 section 内两条 MANUAL、同素材经不同 section 语境重复——素材跨节已由 section 匹配先行消歧）按**出现序**配对；两侧同键数量不等时整组降级为 removed+added 并标记 `matched:"fallback"`，UI 保守呈现。
  - **覆盖场景**：排序变化 = 对匹配成功集合比较 sortOrder 序列输出 moved；MANUAL 内容被编辑 → 指纹变化 → 呈 remove+add（"编辑"与"删除重建"本质不可区分，UI 相邻呈现即可）；增删 = 无对应键集合；originRefId 匹配的行改内容 → 内容差异正常显示。保证最常见路径（克隆→局部小改）不产生"整页删除/新增"噪声。
  - **投影模式区分（不变量）**：Diff 服务产出两套投影——`projection`（过滤 hiddenAt，与预览/导出/AI 文本投影同一口径）与 **`audit`**（包含隐藏行并标注 hidden/unhidden 变化）。版本 Diff 是所有者对自己数据的审计视图（授权 = 同用户所有权校验，不新增权限面），默认 audit 口径以呈现"隐藏/恢复"这类编辑动作。
  - UI 双栏对照 + 变更标记，仅只读展示不回写。
- **V4 回退**：产品语义 = `cloneAsDraft(老版本)` 生成新 DRAFT 并置 `currentVersionId`（已有行为）；UI 命名"以此版本新建草稿"，不改写历史版本；不提供"回退指针"类操作（保持历史不可变）。
- **V5 AI 修改**：AI 产出经 `cloneAsDraft` 落到**新 DRAFT**（`createdVia:"AI"` 新枚举值 + provenance 三列），永不在原地写、不写 FROZEN/SUBMITTED；Diff 视图（V3 audit 口径）作为用户审阅入口。**AI 改写执行路径为后续待批包（§9）**，本合同只冻结数据与语义。
- **V6 旧版本保护**：现有全部不变量保留——FROZEN/SUBMITTED/ARCHIVED 拒绝写；`submittedAttempts` 引用版本拒绝写（`SUBMITTED_RESUME_PROVENANCE`）；`ApplicationAttempt` 绑定字段不可变；`Restrict` FK 兜底；`editVersion` 对不可变版本自动克隆而非改写。

## 7. 篇幅、分页与导出合同（对应要求 6）

### 7.1 篇幅与模板

【建议方案】`layoutConfig` 升级为版本级受控 JSON（列已存在，**无 Schema 变更**）：

```json
{ "template": "standard", "pageTarget": 1 }
```

- 新 `resumeLayoutConfig.ts`：`parseResumeLayoutConfig`/`sanitizeResumeLayoutConfig`（zod 或等价手工校验；未知键剥离、非法值回退默认 `{template:"standard", pageTarget:null}`）；v1 `template` 白名单仅 `["standard"]`，`pageTarget` ∈ `{1,2,null}`。
- 写入仍走 `updateDraft`/`updateHeaderSnapshot` 同闸门；`cloneAsDraft` 继承（已有）。
- 模板：v1 单模板 `standard`（现有 ResumePreview 样式固化）；不做自由画布（P1 明确）。多模板位为后续预留，白名单拒绝未知值。
- `pageTarget` 为**软目标**：页数 > 目标时顶部/预览显示溢出提示，**不阻断冻结与导出** → D5 待决策（推荐软目标，硬阻断会把用户卡在无法导出的状态）。

### 7.2 分页预览（待验证方案，如实标注）

【建议方案】连续文档的 `offsetTop`/`offsetHeight` 测量**不能**复现打印行为：`break-inside: avoid` 会使放不下的 item 整块移到下一页（页底留白）、`break-after: avoid` 会移动标题，且超长块仍会被分片——这些由 Chromium fragmentation 引擎执行，几何读数模拟不了。因此分页预览采用 **CSS 多栏分片器模拟**：

- 编辑器内渲染与 `print.css` 等价样式的**测量副本**，容器设置 `columns: 180mm; column-gap: 0; column-fill: auto; height: 267mm`（A4 portrait − 2×15mm = 内容盒 180×267mm），**每个栏 = 一页**。多栏分片与打印分页共用同一 Chromium fragmentation 引擎，断页规则（`break-inside: avoid`/`break-after: avoid`）天然生效。
- 测量：读各原子块（section 标题块、item 块）的 `offsetLeft` 得所在栏即所在页；实际占用栏数 = 总页数；在编辑器内按栏界绘制页线 + 页码 + 溢出提示。隐藏行不渲染即不参与分片（R2）。
- 覆盖场景：
  - **整块移页**：item 在当前栏放不下即整块进入下一栏，页底空白由引擎自然产生；
  - **超长条目**：块高 > 267mm 时引擎照常分片，测量将该条目标记"跨页"并提示；
  - **标题孤行**：h3 的 `break-after: avoid` 由引擎处理（标题随首个 item 移页），无需手算绑定；
  - **字体加载**：首次测量前 `await document.fonts.ready`（同 `ResumePrintReady` 门），就绪前不绘制页线；
  - **缩放**：测量子树禁用 CSS `zoom`（它影响真实布局），显示缩放一律 `transform: scale()`（不影响测量）；视口/缩放变化 debounce 重测。
- **【不变量】判断性验收**：建立固定 fixture 集 ≥5 例（密集 bullets、>1 页超长 item、section 标题恰卡页界、含隐藏行、中英文混排），逐 fixture 断言**预览的页数与逐元素分页结果 === 导出 PDF 的实际分页**。PDF 侧核验用已装依赖 `unpdf` 逐页抽取文本（导入链路已用），比对标记文本落在第几页。**任何 fixture 不一致即判定合同违反**，不以"近似"验收、不设经验误差承诺。
- **失败回退阶梯**（按序降级，各级独立可验）：
  1. 多栏分片器模拟（推荐，引擎级一致）；
  2. 手工分片模拟：按块高走块序列、显式实现 avoid 规则与孤行绑定（实现与偏差风险更高）；
  3. 低保真降级：仅 `scrollHeight/267mm` 估算页数 + 溢出提示 + 显式"以导出 PDF 为准"标注——**不满足 P1 分页验收，仅作临时降级**，须在台账记录。
- **不一致时用户行为**：预览页线旁常驻"预览分页为近似，导出 PDF 为权威"文案；`pageTarget` 超页仅提示不阻断（D5）；用户发现导出 PDF 分页与预览不一致时调整内容/隐藏项后重新导出即可，artifact 按版本存留可回看。

### 7.3 导出

【已有事实】PDF 全链路已实现并验收（§1.5）；Web 宿主禁用为既定设计。

【建议方案】可编辑文档导出（推荐 **DOCX**）：

- 新增依赖提案：`docx`（npm，段落/标题/列表生成 OOXML；成熟、纯 JS、Node 可用）——**仅提案不安装**，批准后由 Owner 执行 `npm add` 并锁定版本。备选：导出单文件 `.html`（零依赖，Word/WPS 可打开编辑，格式保真度低）→ D3 待决策。
- 生成路径：服务端从版本图（过滤 hiddenAt）生成 DOCX 字节 → `ResumeArtifact`（`kind:"EXPORT"`，`format:"DOCX"`，复用 storageKey/sha256/去重/pending 机制）→ 下载 route 按 format 映射 MIME（`application/vnd.openxmlformats-officedocument.wordprocessingml.document`）。
- `ResumeArtifactService` 需扩展：`openForDownload`/`existingExport` 的 format 白名单 `PDF|DOCX`；DOCX 由服务端生成（**不接受客户端上传字节**，与 PDF 路径不同——PDF 保留现有客户端渲染→上传→下载）。
- 导出门禁不变：FROZEN/SUBMITTED；DRAFT 导出 PDF 维持"冻结后导出"流程，DOCX 同规则。
- 导出后用户自行在外部编辑器精修排版（P1 既定）；回导不在范围。

## 8. 持久化、备份与 AI 边界（对应要求 7）

### 8.1 Schema 与备份（提案；共享文件归属见 §8.3）

- **新列**（additive，nullable，无默认值、无 backfill，一条增量 Migration）：
  - `ResumeVariantSection.hiddenAt`、`ResumeVariantSectionItem.hiddenAt`、`ResumeExpression.hiddenAt`（`DateTime?`，R2）；
  - `ResumeVariantSection.originRefId`、`ResumeVariantSectionItem.originRefId`、`ResumeExpression.originRefId`（`String?`，V3 跨版本对应键，无 FK）；
  - `ResumeImportAttempt.confirmedSelectionSha`（`String?`，I6 选择签名）。
- **备份**：`BACKUP_FORMAT_VERSION` bump 至**集成时下一个可用版本**（本文不预定版本号——以 ACTIVITY-RETIRE 集成后的实际备份版本为基线）；三张 row schema 增对应 optional 字段；`INSERT_ORDER`/idmap/`EMPTINESS_MODELS` 不变；`ResumeImportAttempt` 维持 `INTENTIONALLY_EXCLUDED`（新列随之不进备份，无影响）；旧版本备份导入 = 新列 NULL（`originRefId` NULL 的行 Diff 走内容匹配回退，语义已定义）；旧程序拒绝新格式（literal 版本校验先例保留）。
- `ResumeArtifact` DOCX 行随版本进备份，字节仍不进备份（`bytesMissing` 语义扩展至 DOCX）。
- `layoutConfig` row schema 已存在（optStr），无备份改动；**非法 JSON 容忍**：读取侧 `parseResumeLayoutConfig` 失败回退默认，不抛错（对齐 headerSnapshot 容错惯例）。

### 8.2 AI 调用边界

- 复用 `purpose:"RESUME"` 分配 + `executeStructuredForAssignment` + Managed provenance 锁；AI 改写输出仅作**建议**经 §6 V5 落新 DRAFT（后续待批包）。
- prompt 输入白名单：headerSnapshot 六字段 + Section/Item/Expression 文本 + 素材/证据内容（standard dataset）。**敏感对象构造性排除**（证件/证明人/附件/敏感表字段永不进 prompt——与 Career 合同 §8 一致）；导入已遵守"文档内指令即数据"防注入，AI 改写提示词沿用同一原则。
- Agent 工具面不变：本合同不新增/不扩展 Agent 工具；`get_resume`/`review_resume` 继续只读（文本投影自动过滤 hidden）。

### 8.3 将来要触及的共享文件与归属（建议）

执行不按 Schema/服务/UI 分派独立 Owner：

| 包 | 归属建议 | 文件/范围 |
| --- | --- | --- |
| RESUME-BUILDER 特征整体 | **单一 Builder Owner 端到端**（服务+Action+UI+导出一体） | `resumeVariantService.ts` 增量、新 `resumeLayoutConfig.ts`/`resumeVersionDiff.ts`/`resumeImportExclusions` 相关、`resumeVariant.actions.ts`、`src/components/career/resume-variant/*`（Workspace 重构、MaterialLibraryPanel、PagedPreview、DiffView）、`src/app/api/profile/resume-import/route.ts` confirm 扩展、`resumeArtifactService.ts` 与 `resume-artifacts/**` format 扩展、DOCX 生成器（新文件）、`canonicalResumeImport.ts` 排除子集、DTO 扩展 |
| 共享 Schema + 备份 | **保持 ACTIVITY-RETIRE 现有所有权** | `prisma/schema.prisma`、新 Migration、`src/lib/backup/{schema,ordering,compat}.ts` 必要处；Builder Owner 只提交 §8.1 列规格，由该 Owner 落地，备份版本号以集成时实际为准 |
| i18n / 台账 / wiki | 主协调窗口 | `src/i18n/messages/{en,zh-CN}.json`、`wiki/P1_FEATURES.json`、`P1_IMPLEMENTATION.md`、本文档冻结记录 |
| 桌面 `resume-print.js` | 预计无改动（实现通用） | — |
| Agent / Match | 消费方已含于 hidden 过滤（文本投影属 Builder Owner 改动面） | 无新增写面 |

## 9. 实施顺序与验收（对应要求 8）

按**用户可用成果**组织执行包（不再按 Schema/服务/UI 分派）：

| 包 | 用户可见成果 | 内部依赖 | 范围 |
| --- | --- | --- | --- |
| T1 组装工作台 | 两栏工作台：左素材库（分组/搜索/拖入整条或单条 evidence）＋右编辑与同屏预览；条目排序/隐藏/删减/局部改写 | Schema 列落地（§8.3 归属）、服务/Action 增量、D1/D2 冻结 | **本期** |
| T2 版本与岗位 | 版本切换/新建草稿/克隆回退、目标职位更换、版本 Diff 审计视图（含隐藏变化） | diff 投影服务、originRefId 列 | **本期** |
| T3 篇幅与分页 | 顶部模板/篇幅控制、分页预览页线与页数、溢出提示 | T1、D4/D5 冻结；分片器方案验收 | **本期** |
| T4 导出 | PDF 链路回归 + DOCX 生成/存取/下载 | D3 冻结 | **本期**（依赖批准后可与 T3 并行） |
| T5 导入校对增强 | 预览条目级排除 + 选择签名幂等重放 | §5 I5/I6 不变量 | **本期**（推荐保留；若 Owner 削减范围可独立摘除，不影响 T1–T4） |
| T6 集成收尾 | 备份往返验证、i18n、台账同步、隔离 Electron 验收 | T1–T5 完成 | **本期** |
| F1 AI 修改→新 DRAFT | AI 改写落新版本 + audit Diff 审阅 | T2（Diff）、专项合同、`createdVia` 扩展 | **后续待批** |
| F2 其他增强 | 粘贴文本导入（D6）、多模板、版本 ARCHIVED UI、版本级 JD 绑定（D10） | 各自冻结决策 | **后续待批** |

内部依赖顺序备忘：Schema/备份列落地 → 服务/Action → 工作台 → 分页/Diff → DOCX →（后续）AI。最低验收矩阵（Feature 级，未过不置 `passes`）：

| 验收项 | 必须满足 |
| --- | --- |
| 数据不变量 | 删 Item/Expression/Section 不动素材；hiddenAt/originRefId 往返持久化且克隆保留；MANUAL 删除有差异提示；reorder 全序校验与并发闸门回归通过 |
| 工作台 | 左栏分组/搜索/拖拽入库（整条+单条 evidence）；右栏同屏实时预览；拖拽排序落库一致；隐藏灰显且预览/投影/导出全部跳过 |
| 岗位版本 | 版本切换/新建/克隆；targetJob 更换持久化；**Diff 对克隆→小改版本输出局部差异而非整页增删**；audit 口径可见 hidden 变化；回退=克隆不改历史 |
| 绑定兼容 | FROZEN/SUBMITTED/被引用版本拒绝写（回归）；Attempt 绑定/下载链路不变 |
| 分页/篇幅 | §7.2 fixture 集页数与逐元素分页 === 导出 PDF 实际分页；溢出提示正确；软目标不阻断 |
| 导出 | PDF 链路回归；DOCX 生成→artifact→下载→可打开编辑；字节不进备份的恢复再导出可行 |
| 导入 | 现有 verbatim 校验与 durable 幂等回归；**排除校验两步顺序**（先完整结果校验再选择校验）；条目排除生效；同 requestId 同选择重放一致、异选择拒绝；uncertainty/conflict 提示可见 |
| 宿主 | 隔离 Windows Electron fresh-native（resume_v1|full）真实路径验收：导入→校对→拖拽→版本→分页→导出往返 |

## 10. 待决策汇总（Owner）

2026-10-29 确认：**D2、D3、D5、D6 按下表推荐方案批准**。AI 改写执行路径与粘贴导入保持后续待批。其余条目保持各自提案或技术实施约束，不因本次确认自动批准。分页方案须先做技术验证；单个元素的 `offsetLeft` 不能代表跨栏条目的全部片段，应测量文本/元素片段与实际 PDF 页界，不得以该字段单独证明分页一致。

| # | 决策项 | 推荐 | 理由 |
| --- | --- | --- | --- |
| D1 | 隐藏列范围 | **三级统一 `hiddenAt`**（Section+Item+Expression） | 语义一致、渲染过滤规则单一；若仅 Item+Expression，隐藏 Section 需"全 item 隐藏"近似，语义不直观 |
| D2 | 拖拽方案 | **`@dnd-kit/core`+`sortable`+`utilities`** | 跨容器拖拽/键盘可及/维护活跃，优于手写 HTML5 DnD；**新依赖提案**，批准并核对发布后装 |
| D3 | 可编辑导出格式 | **DOCX（`docx` 包）** | .docx 是中文求职场景事实标准（WPS/Word）；HTML 为零依赖备选但保真低；PDF→可编辑转换不可行 |
| D4 | 分页预览口径 | **CSS 多栏分片器模拟 + "PDF 为权威"声明** | 与打印共用 fragmentation 引擎、可判断性验收（fixture===PDF）；不达标走 §7.2 回退阶梯 |
| D5 | pageTarget 语义 | **软目标（提示不阻断）** | 硬阻断会把用户困在"超页无法导出"；溢出提示+导出放行是行业惯例 |
| D6 | 导入校对增强范围 | **本期交付条目级排除；不引入"待确认"第三态；粘贴文本导入后续再议** | 排除补齐"校对"能力且 §5 已给出完整服务端合同；第三态收益小；粘贴文本可后置 |
| D7 | `materialTitleSnapshot` 刷新 | **提供可选"同步素材标题"操作** | 快照语义保留为默认；显式刷新解决素材改名后简历陈旧体验，不改历史版本 |
| D8 | AI 改写 `createdVia` | **新增 `"AI"` 值 + provenance 三列**（执行路径后续待批） | 与 USER/IMPORT/LEGACY_BACKFILL 并列；满足"AI 修改默认新版本+可追溯" |
| D9 | 表达式 kind 使用 | **evidence 播种=BULLET；导入保持 BODY；HEADLINE 预留** | 语义化而不改写历史数据 |
| D10 | `targetJdVersionId`/版本 ARCHIVED UI | **均不接线本期** | JD 版本级绑定是 Deep Match 前置；版本级归档 UI 无用户诉求证据，状态机保留 |
| D11 | MANUAL item 删除提示 | **保留删除能力，删除前文案明示"内容仅存于本版本"** | 与素材条目"删了还能再拖回"形成正确心智差异 |

## 11. 冻结后施工注意

- `hiddenAt` 消费方清单即 §3 R2，漏一处 = 隐藏内容泄漏到 PDF/Agent/匹配文本，列为硬验收；唯一例外是 §6 V3 的 `audit` Diff 口径。
- `originRefId` 由行创建路径统一赋值、`copyVersionGraph` 原样保留；`cloneAsDraft` 须同时复制 `hiddenAt`（"克隆即所见"）。
- 导入排除的两步顺序不可颠倒：先对**签名内完整结果**跑 `validateResumeImport`，再校验选择并构造持久化子集；禁止把排除后子集送入原文覆盖校验。
- `confirmedSelectionSha` 只在首次成功落库时写入；replay 比对失败拒绝而非静默返回——"不重复写"已由 requestId 主键保证，"不悄悄换结果"由签名比对保证。
- `listResumeCareerMaterials` DTO 需扩展 detail 摘要字段（服务层组装的只读投影，不直接透传 detail 行）。
- `openForDownload`/`existingExport`/`POST` 路由的 format 白名单与 MIME 映射必须同步扩展（防"行有字节无"或错 MIME）。
- `guardDraftMutationInTransaction` 是唯一写闸门：新服务方法（attach/seed/hide/target job）一律经其锁定版本，不旁路。
- 打印页与 Diff 仅读，不引入任何版本写路径；`/resume-print` 仅 FROZEN/SUBMITTED 现状保留（DRAFT 打印不在本合同范围）。
- 分页预览测量子树禁用 CSS `zoom`；页线绘制须等待 `document.fonts.ready`。
- i18n 与台账文件只归主协调窗口；各包不自行改 `P1_FEATURES.json` 状态。
- 任何物理删除路径不新增；"删除"在素材域=归档，在版本域=删版本行（语义不同需文案区分）。
