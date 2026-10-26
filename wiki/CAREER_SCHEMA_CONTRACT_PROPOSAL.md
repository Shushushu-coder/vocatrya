# 职业资料 Schema 合同提案（CP-SCHEMA / CP-RECORDS / CP-PRIVACY 前置）

本文档是职业资料新增字段与模型开发前的合同收口方案，供冻结后作为 `CP-SCHEMA`、`CP-RECORDS`、`CP-PRIVACY` 及后续 UI/复制工作包的实现依据。本文档**不修改任何运行时代码、Schema、Migration 或备份代码**。

**标注约定**

- 【已有事实】：代码、Migration、规格文档或 wiki 中已存在并核实的内容，施工必须遵守。
- 【建议方案】：本文档提出的待冻结方案，给出具体字段、关系、校验与实现建议。
- 【待决策 D#】：需要 Owner 明确选择的开放项，汇总于 §10，每项给出推荐及理由。

**重要声明（M1/M2 清单状态）**

`wiki/MVP_IMPLEMENTATION.md` 引用"M1 精确 35 列 diff + M2 三模型（`CareerLanguageDetail` / `CandidateReferee` / `CandidateAttachment`）"作为 CP-SCHEMA 的输入，并在附录第 5 条明确指出**该 35 列清单未在仓库 docs 中定位**。本次对 `docs/`、wiki、源码的检索同样未找到逐字段的 M1/M2 冻结清单；`docs/` 目录本身未纳入 Git。因此：

- 本文档 §2 的字段映射与 §5 的候选列清单是**建议方案基线**，不是已批准的"35 列"合同。
- M2 三个模型名（`CareerLanguageDetail` / `CandidateReferee` / `CandidateAttachment`）已确认**不存在于** `prisma/schema.prisma`；本文档 §3 给出其建议定义。
- 若 Owner 持有外部 M1/M2 清单，以清单为准逐项核对本提案；否则建议以本文档为候选冻结基线（D1）。

依据文档：
- 产品规格：`docs/resources/Vocatrya_职业资料_V1_重构决策与呈现规格.md`（2026-10-21，未纳入 Git，以下称"规格"）。
- 基线：`main @ 8d623b61`；`prisma/schema.prisma`；`wiki/MVP_FEATURES.json`；`wiki/MVP_IMPLEMENTATION.md`；`prisma/MIGRATION_INVARIANTS.md`。

## 0. 目的与范围

回答七个问题：

1. 规格各 Tab 字段相对现有 Schema，哪些已有、哪些可复用、哪些是真实缺口（§2）。
2. 语言能力、证明人、附件三个新对象的归属、字段、可空性、校验与删除/归档语义（§3）。
3. 最高学历、学校城市、毕业届次等派生值的来源与多记录选择规则（§4）。
4. 既有模型需要新增哪些列、哪些内容应继续走 notes/evidence/structuredData 而非新列（§5）。
5. 新 Migration 的兼容方案、历史数据处理与敏感信息保护（§6）。
6. 新增字段/模型对备份格式的影响与建议兼容方案（§7，仅提案）。
7. 后续可独立交付的开发包、依赖与准确文件 Owner（§9）。

非目标：不实现 Schema/Migration/代码；不规划整个 MVP；不做像素级 UI 规范。

## 1. 现状证据核对

### 1.1 Schema 已有事实

**候选人聚合（userId 唯一）：**

- `CandidateProfile`（`schema.prisma:1322`）：`fullName/headline/email/phone/address/linksData/extraData/gender/birthDate/ethnicity/politicalStatus/nativePlace/householdRegistration/graduationCohort`。`birthDate` 为 `String?`（非 DateTime），服务层按 `YYYY-MM-DD` 严格校验。
- `CandidateSensitiveInfo`（`:1348`，userId 唯一，`onDelete: Cascade`）：`idNumber/emergencyContactName/emergencyContactRelation/emergencyContactPhone`；下挂 `CandidateFamilyMember`（name/relation/employer/position/phone/sortOrder）。
- `JobSearchPreference`（`:1080`，userId 唯一）：targetRoles/preferredCities/preferredIndustries/recruitmentTypes/availability/hardConstraints/softPreferences。按规格保留数据、移出导航，不删除。

**职业事实聚合：`CareerMaterialItem` + 12 类 Detail + `CareerEvidence`（`:1098-1320`）**

- 父表：`type`（12 值字符串枚举，`identities.ts:146`：EMPLOYMENT/INTERNSHIP/PROJECT/RESEARCH/PUBLICATION/COMPETITION/CAMPUS_ACTIVITY/EDUCATION/AWARD/SKILL/CERTIFICATION/CUSTOM）、`title`、`startDate/endDate`、`isCurrent`、`notes`、`origin`、`verificationStatus`、`archivedAt`。服务层不变量：`type` 与 detail 表严格一对一（Prisma 无法表达 XOR）。
- 每个 detail：`materialItemId @unique`，`onDelete: Cascade`，均带 `structuredData String @default("{}")` 逃生舱（迁移与简历导入用于写入 provenance：`{source, sourceText, fields, uncertainty}`，见 `canonicalResumeImport.ts:17`、`migrator.ts:1115`）。
- 各 detail 现有业务列：
  - `CareerEducationDetail`：institution/degree/fieldOfStudy/locationText/**gpaValue/gpaScale/rankText**
  - `CareerInternshipDetail`：companyId/organizationName/roleTitle/locationText
  - `CareerEmploymentDetail`：companyId/organizationName/roleTitle/employmentType/locationText
  - `CareerProjectDetail`：roleTitle/projectUrl/organizationName
  - `CareerResearchDetail`：institution/roleTitle/field
  - `CareerPublicationDetail`：venue/authors/url/publishedAt
  - `CareerCompetitionDetail`：organizer/awardLevel/result
  - `CareerCampusActivityDetail`：organizationName/roleTitle
  - `CareerAwardDetail`：issuer/awardedAt（**无 awardLevel**，与竞赛 detail 不对称）
  - `CareerSkillDetail`：skillName/proficiency
  - `CareerCertificationDetail`：organization/credentialUrl/issueDate/expirationDate（**无证书编号**）
  - `CareerCustomDetail`：仅 structuredData
- `CareerEvidence`：kind/content/metricValue/metricUnit/metricText/sortOrder/origin/verificationStatus/archivedAt，`onDelete: Restrict`（随父归档，不物理删除）。
- `File`（`:148`）：fileName/filePath/fileType，仅被 `Resume.FileId` 引用；上传路径限定 `UPLOADS_DIR/files/resumes`（`isResumeFilePath`），**不是通用附件表**。
- 旧版 `Education`/`WorkExperience`/`LicenseOrCertification`/`OtherSection`/`Skill`/`ContactInfo` 为 legacy 表，Phase 3 已 backfill 进 `CareerMaterialItem`（`LegacyMigrationMap` 幂等键），不回写。

### 1.2 读写路径已有事实

- `CandidateProfileService`（`src/lib/career/candidateProfileService.ts`）：性别枚举 `男/女/其他`、政治面貌 5 值枚举、birthDate ISO 校验、email/phone 正则；`replaceCandidateFamilyMembers` 为整组替换（deleteMany+createMany 事务）。
- `CareerMaterialService`（`careerMaterialService.ts`）：create/update/list/archive/confirm/addEvidence；**删除语义 = `archive()`（写 `archivedAt`），无物理删除路径**；`fullDetailInclude` 硬编码 12 个 detail 关系。
- `careerMaterialInput.ts`：`APPLICATION_PROFILE_DETAIL_FIELDS` 为网申页写白名单（10 类型，EMPLOYMENT/CUSTOM 明确排除），`FORBIDDEN_DETAIL_KEYS` 含 `structuredData/companyId` 等；未知键**拒绝**而非静默剥离。
- `sensitiveMask.ts`：maskName/maskPhone；`isSensitiveFieldKey` 目前仅覆盖紧急联系人三字段（注释明确 idNumber/family members 延期）。
- `applicationCopy.ts`：`PERSONAL_INFO_COPY_FIELDS` 11 键白名单（构造上排除敏感字段）；投影 sections = basics/preference/education/experience/skills。
- `applicationProfile.actions.ts`：紧急联系人走"概览掩码 → 显式 reveal → 字段级 copy → 差量保存"模式；写响应不回明文。
- `access.ts`：READ/WRITE/COPY 三闸门统一走 runtime mode；COPY 用 READ 闸门。
- UI：`ApplicationProfileWorkspace` 已实现七 Tab + 显隐持久化（`careerProfileTabs.ts`，`CAREER_PROFILE_RECORD_TAB_TYPES` 已定各 Tab 与 material type 的映射）；教育 Tab 与网申 Tab 已有"暂未支持结构化语言成绩"占位文案（`languageTestUnsupported`）；`materialFields.ts` 与服务端白名单一一镜像。
- `careerProfileTabs.ts` 注释即为冻结合同："research and publications are sub-modules of 教育经历；competitions count toward 获奖经历；skills, certifications, campus activities and custom entries live under 其他"。

### 1.3 备份与迁移已有事实

- 备份 `BACKUP_FORMAT_VERSION = 4`，`SUPPORTED = [1,2,3,4]`（`src/lib/backup/schema.ts:14`）。
- `ordering.ts`：`MODEL_SPECS` 定义每模型的 delegate/fks/scope/`dataset`；`dataset: "sensitive"` 目前仅 `CandidateSensitiveInfo` 与 `CandidateFamilyMember`；`INSERT_ORDER` 为权威插入序，`SENSITIVE_BACKUP_MODELS`/`modelsForBackup`/`modelsForWipe` 全部由此派生。
- `BackupDataSchema`：每模型一个 zod row schema + `group()` 默认 `[]`。**zod object 默认剥离未知键**：导出端 `collectBackupData` 末尾 `BackupDataSchema.parse` —— 若 DB 新列未同步进 row schema，导出**静默丢弃**；恢复端未知 group 同样被剥离。新字段必须同步 row schema，否则备份丢数据。
- `coverage.ts`：`backupCoverageStatus` 对未分类的 Prisma 模型返回 `undefined`，由覆盖守护测试拦截 → **新模型必须显式归入 INSERT_ORDER 或 INTENTIONALLY_EXCLUDED**。
- `compat.ts`：v3/v4 manifest 必须携带 `containsSensitiveData`；标准备份中含敏感 group 直接报错；旧 `ResumeContactProfile` 键重映射到 `CandidateProfile`。
- 导出只内嵌 `isResumeFilePath` 命中的 File 字节（`files/<id>/<name>` 条目 + `fileMissing` 标记）。
- Migration：`prisma.config.ts` 指向 `migrations/`；最新 `20261026000000_datetime_v1_additive_columns` 为 additive-only 先例（加列、全 NULL、不 UPDATE、不 backfill）。`MIGRATION_INVARIANTS.md`：`migrate dev --create-only` → 人工审查 SQL → `migrate deploy` → `npm run db:verify-migration-invariants`；仅 AIConnection 重建时需手工补部分唯一索引（纯新增列/新表不触发）。
- AGENTS 规则：不改写已执行 Migration，Schema 修改通过新 Migration。
- SQLite 存储事实（datetime 提案已核实）：`DateTime` 列存 epoch ms，裸 `YYYY-MM-DD` 写不进去 → **纯日期语义新列必须用 TEXT（`*On`）**，与 `deadlineOn/dueOn` 及 `birthDate String` 先例一致。

### 1.4 规格文档确认的边界（【已有事实】）

- 七 Tab IA 与显隐持久化已定；隐藏 Tab ≠ 删除数据、≠ 改变复制范围。
- 敏感字段（证件、证件照、紧急联系人、证明人）**默认保护且不自动进入批量复制**；字段级敏感复制需用户明确操作。
- **最高学历、学校城市、毕业届次不再在个人信息中手工维护**，由教育经历派生供网申使用。
- 不同地点字段保留自身语义，**不以单一"地址"互相替代**。
- GPA 保存原始成绩与满分基准，不强制转换；网申截图红星号不成为全局必填。
- 与教育相关的奖项如何避免双份维护"留待实现设计"——本提案列为决策项而非已定事实。
- 全局求职意向保留数据、移出导航；历史数据如何保留/迁移需另行授权。
- 本轮规格"非逐字段校验、精确复制模板、敏感信息授权弹窗、数据存储/迁移方案的最终实现规范"——即字段级合同正是本提案要补的内容。

## 2. 字段映射总表

逐项对照规格 §3 与现有 Schema。状态：`已有` = 列存在且已被写路径使用；`已有未接线` = 列存在但 V1 UI/写路径未开放；`可复用` = 语义可承载但需决策；`缺口` = 需要新增列/模型/决策。

### 2.1 个人信息（Tab：personal → `CandidateProfile` / `CandidateSensitiveInfo`）

| 规格字段 | 现有列 | 状态 | 建议 |
| --- | --- | --- | --- |
| 姓名 | `fullName` | 已有 | — |
| 性别 | `gender`（枚举 男/女/其他） | 已有 | 规格枚举为 男/女/保密 → D2 |
| 出生日期 | `birthDate`（String ISO） | 已有 | — |
| 国家/地区 | — | 缺口 | 新列 `countryOrRegion` |
| 证件类型 | — | 缺口 | 新列放 `CandidateSensitiveInfo.idType`（与 idNumber 同属证件事实，继承敏感边界） |
| 证件号码 | `CandidateSensitiveInfo.idNumber` | 已有未接线 | 保留敏感表，UI 按紧急联系人模式开放 |
| 民族 | `ethnicity` | 已有 | — |
| 证件照 | — | 缺口 | `CandidateAttachment`（category=ID_PHOTO）→ §3.3 |
| 手机号码 | `phone`（单列，正则允许 `+` 前缀） | 已有 | 规格要求"国际区号＋号码"分控件 → D3 |
| 邮箱 | `email` | 已有 | — |
| 微信号 | — | 缺口 | 新列 `wechatId` |
| QQ号 | — | 缺口 | 新列 `qqNumber` |
| 当前所在地 | — | 缺口 | 新列 `currentCity`；**不复用 address**（规格禁止语义混用） |
| 家庭所在城市 | — | 缺口 | 新列 `homeCity` |
| 家庭常驻地址 | `address`（语义笼统，历史值=简历联系地址） | 可复用 | 建议新列 `homeAddress`，`address` 保留为既有语义待 D4 |
| 户籍所在地 | `householdRegistration` | 已有 | — |
| 籍贯 | `nativePlace` | 已有 | — |
| 政治面貌 | `politicalStatus` | 已有 | 规格未列；保留不删 |
| 紧急联系人姓名/关系/电话 | `CandidateSensitiveInfo.emergencyContact*` | 已有 | 规格"按需支持区号"并入 D3 |
| 最高学历 / 学校城市 / 毕业届次 | 仅 `graduationCohort` 手工列 | 缺口 | 派生 → §4 |
| headline / linksData / extraData | 三列存在 | 已有未接线 | `linksData` 候选承载"作品/个人主页" → D9 |

### 2.2 教育经历（Tab：education → `CareerMaterialItem` + `CareerEducationDetail` 等）

| 规格字段 | 现有列 | 状态 | 建议 |
| --- | --- | --- | --- |
| 学历 | `degree` | 已有 | 自由文本；派生需受控词表 → D5 |
| 学校全称 | `institution` | 已有 | — |
| 学校所在地 | `locationText` | 已有 | 派生"学校城市"来源 → §4 |
| 目前就读地 | — | 缺口 | `currentStudyLocation`（与 locationText 语义分立） |
| 院系/学院 | — | 缺口 | `department` |
| 专业类别 | — | 缺口 | `majorCategory` |
| 专业 | `fieldOfStudy` | 已有 | — |
| 开始/结束时间 | `item.startDate/endDate`（DateTime） | 已有 | — |
| 毕业时间（实际或预计） | — | 缺口 | `graduationOn`（TEXT DateOnly）+ `graduationExpected` 标记；或复用 endDate+isCurrent → D6 |
| 学习形式 | — | 缺口 | `studyMode`（全日制/非全日制/在职等） |
| 是否交换经历 | — | 缺口 | `isExchange Boolean @default(false)` |
| GPA 实际成绩 / 满分基准 | `gpaValue`/`gpaScale` | 已有 | **不重复新增**，规格已冻结保留原值 |
| 成绩/班级/专业排名 | `rankText`（单列自由文本） | 部分 | D7：保留 rankText=综合/成绩排名，是否拆 classRankText/majorRankText |
| 是否国家奖学金 | — | 缺口 | `hasNationalScholarship Boolean @default(false)` |
| 科研信息：导师/实验室/研究方向 | `CareerResearchDetail.institution/roleTitle/field`（独立 RESEARCH 材料） | 可复用 | D8：EducationDetail 内嵌列 vs RESEARCH 关联记录 |
| 论文：名称/期刊/等级/作者身份/GitHub | `title/venue/—/—/url`（authors 为自由文本） | 部分 | 新增 `venueLevel`、`authorRole` 到 CareerPublicationDetail |
| 语言能力（可多条） | —（仅有"暂未支持"占位） | 缺口 | `CareerLanguageDetail` → §3.1 |

### 2.3 实习经历（Tab：internship → `CareerInternshipDetail`，EMPLOYMENT 只读展示）

| 规格字段 | 现有列 | 状态 | 建议 |
| --- | --- | --- | --- |
| 公司名称 | `organizationName`/`companyId` | 已有 | — |
| 部门 | — | 缺口 | `department` |
| 岗位 | `roleTitle` | 已有 | — |
| 工作地点 | `locationText` | 已有 | — |
| 起止时间 | `item.startDate/endDate/isCurrent` | 已有 | — |
| 工作职责/实际工作内容/个人贡献/量化成果 | `item.notes` + `CareerEvidence`（FACT/METRIC） | 可复用 | D10：叙述字段走 notes+evidence vs 新增文本列 |

### 2.4 项目经历（Tab：project → `CareerProjectDetail`）

| 规格字段 | 现有列 | 状态 | 建议 |
| --- | --- | --- | --- |
| 项目名称 | `title` | 已有 | — |
| 项目类型 | — | 缺口 | `projectType` |
| 担任角色 | `roleTitle` | 已有 | — |
| 起止时间 | `item.startDate/endDate` | 已有 | — |
| 项目背景/目标/个人职责/所用技术/成果/相关链接 | `notes`+`evidence`+`projectUrl` | 部分 | 同 D10；技术栈如需结构化可加 `techStack`，否则 evidence |

### 2.5 获奖经历（Tab：awards → `CareerAwardDetail` + `CareerCompetitionDetail`）

| 规格字段 | 现有列 | 状态 | 建议 |
| --- | --- | --- | --- |
| 奖项名称 | `title` | 已有 | — |
| 奖项类型 | — | 缺口 | `awardType`（竞赛/奖学金/荣誉等） |
| 等级 | `CareerCompetitionDetail.awardLevel` 有，`CareerAwardDetail` 无 | 缺口 | `CareerAwardDetail.awardLevel`（对齐竞赛） |
| 颁发机构 | `issuer` | 已有 | — |
| 获奖时间 | `awardedAt`（DateTime） | 已有 | — |
| 个人/团队 | — | 缺口 | `awardScope`（INDIVIDUAL/TEAM） |
| 描述 | `item.notes` | 已有 | — |
| 证明材料 | — | 缺口 | `CandidateAttachment` 关联 materialItemId → §3.3 |
| 与教育关联奖项去重 | — | 未定义 | D11（规格明示留待实现设计） |

### 2.6 其他（Tab：other → 多个 detail 类型 + 新对象）

| 规格子模块 | 现有承载 | 状态 | 建议 |
| --- | --- | --- | --- |
| 证书 | `CareerCertificationDetail`（organization/credentialUrl/issueDate/expirationDate） | 已有 | 缺 `credentialId`（证书编号） |
| AI 应用技能 | `CareerSkillDetail`（skillName/proficiency） | 可复用 | D12：SKILL 复用 vs 独立类型；"应用场景/经验"入 notes/evidence |
| 作品/个人主页 | `CandidateProfile.linksData`（未接线）或 CUSTOM | 可复用 | D9 |
| 资料证明人 | — | 缺口 | `CandidateReferee` → §3.2 |
| 其他关键信息 | `CareerCustomDetail` | 已有 | — |

### 2.7 网申资料（Tab：application → 只读投影）

【已有事实】`getApplicationProjection` + `buildApplicationProjectionSections` 已按白名单组装 basics/education/experience/skills，敏感数据构造上不可达。新增非敏感字段如需进入汇总，**显式加入 `PERSONAL_INFO_COPY_FIELDS`**；敏感对象（证件/证明人/附件）永不加入（§8）。派生值在投影层组装，不落库（§4）。

## 3. 新对象合同

### 3.1 语言能力 —— `CareerLanguageDetail`

【待决策 D13：载体】
- **推荐 A**：新增 material type `LANGUAGE` + 1:1 `CareerLanguageDetail`，与既有 12 类同构。
  - 理由：语言是"可多条"记录，直接复用归档（archivedAt）、排序、evidence 挂载、复制本条、备份 scope（byMaterial）与类型白名单机制；M2 计划名即为 `CareerLanguageDetail`；教育 Tab 占位文案已预留。
  - 备选 B：`CandidateProfile` 下挂独立 `CandidateLanguage` 表——不享材料机制，需自建归档/复制/备份 scope，无理由分叉。
- 【建议方案】归属：挂 `CareerMaterialItem`（`languageDetail` 关系，`materialItemId @unique`，`onDelete: Cascade`）；`CAREER_MATERIAL_TYPE` 增 `LANGUAGE`；`careerProfileTabs` 将 `LANGUAGE` 归入 `education` Tab。
- 【建议方案】字段（规格："语言、等级/考试、成绩（适用时）"）：

  | 列 | 类型 | 可空 | 说明 |
  | --- | --- | --- | --- |
  | `language` | String? | 是* | 语种（英语/日语/…）；*服务层要求 `language` 与 `examOrLevel` 至少其一，或沿用 `item.title` 必填代替 |
  | `examOrLevel` | String? | 是 | 等级/考试（CET-4/6、IELTS、TOEFL、HSK、自由等级） |
  | `score` | String? | 是 | 成绩适用时；String 而非 Float（可为 "7.5"、"600"、"通过"、"B2"）；量化另走 `CareerEvidence.metricValue` |
  | `obtainedOn` | String? | 是 | 取得日期，TEXT DateOnly（可选，规格未列） |
  | `structuredData` | String @default("{}") | 否 | 沿用 detail 惯例，仅 provenance |

  - `item.title` 建议由服务层写为 `language`（或"语言 · 考试"），保持记录列表可读；`item.startDate/endDate` 不强制使用。
  - 校验：语种与考试均自由文本（trim 非空规则同 `assertApplicationMaterialCreateTitle`）；`obtainedOn` 复用 `isValidIsoDate`；score 无格式约束。
  - 删除/归档语义：沿用 `archive()`（archivedAt），无物理删除；恢复/列表过滤沿用现有 includeArchived。
  - 涉及代码点（仅枚举归属，不实现）：`identities.ts`（type）、`schema.prisma`、`careerMaterialService.detailCreateKey/fullDetailInclude`、`careerMaterialInput.APPLICATION_PROFILE_DETAIL_FIELDS`、`materialFields.ts`、`careerProfileTabs.ts`、备份 MODEL_SPECS/row schema、i18n。

示例行（冻结后形态）：

```json
{
  "type": "LANGUAGE",
  "title": "英语 · IELTS",
  "languageDetail": {
    "language": "英语",
    "examOrLevel": "IELTS",
    "score": "7.5",
    "obtainedOn": "2025-03-15",
    "structuredData": "{}"
  }
}
```

### 3.2 资料证明人 —— `CandidateReferee`

【已有事实】规格 3.6：字段为"姓名、单位、职务、与用户的关系、联系方式等"；**涉及第三方个人信息，默认保护，不自动进入批量复制**（§3.6、§4.3）。

【待决策 D14：归属】
- **推荐 A**：挂 `CandidateSensitiveInfo` 下（`sensitiveInfoId` FK，`onDelete: Cascade`，与 `CandidateFamilyMember` 并列）。
  - 理由：证明人与家庭成员同为"第三方个人信息"；挂敏感聚合使敏感边界**单点成立**：备份 `dataset: "sensitive"` 自动继承、wipe/emptiness 边界一致、遮蔽模式统一（参照 EmergencyContactCard）。
  - 备选 B：顶层 `userId` scope（参照 CareerMaterialItem）。生命周期更独立，但需自建敏感边界挂接；备份 scope 需 `dataset: "sensitive"` 手工标注，可行但分散。
- 【建议方案】字段：

  | 列 | 类型 | 可空 | 说明 |
  | --- | --- | --- | --- |
  | `name` | String? | 是* | 姓名；【建议方案】服务层要求 name 必填非空（其余字段可空，与 familyMember 宽松度区分） |
  | `organization` | String? | 是 | 单位 |
  | `position` | String? | 是 | 职务 |
  | `relationship` | String? | 是 | 与用户关系（导师/上级/同事…自由文本） |
  | `phone` | String? | 是 | 复用 `assertPhone` 校验 |
  | `email` | String? | 是 | 复用 `assertEmail` |
  | `note` | String? | 是 | 备注（可证明事项等） |
  | `sortOrder` | Int @default(0) | 否 | 与 familyMember 一致 |
  | `archivedAt` | DateTime? | 是 | 归档而非物理删除（见下） |
  | `createdAt/updatedAt` | DateTime | 否 | — |

- 【待决策 D15：编辑语义】推荐**单条 CRUD + archivedAt 归档**（与材料记录一致：多条独立记录、可单独隐藏不再展示），备选为 `replaceCandidateFamilyMembers` 式整组替换。理由：证明人是独立记录实体，单条语义与 CP-RECORDS"创建多条记录并完成编辑、读取、删除"验收一致；"删除"在代码中等同归档。
- 【建议方案】敏感行为：默认掩码（maskName/maskPhone 复用，relation/organization 可明文——参照紧急联系人 relation 不掩码的先例）；`reveal`/`copyField`/差量保存模式复用紧急联系人 action 形态；写响应不回明文。

### 3.3 附件 —— `CandidateAttachment`

【已有事实】规格要求：证件照（个人信息）、获奖证明材料（获奖 Tab）、字段控件含"上传"。CP-PRIVACY 把附件列为敏感对象。现有 `File` 模型只服务 legacy 简历上传（`isResumeFilePath` 限定 resumes 目录），不复用。

【建议方案】归属：顶层 `userId` scope 新表（附件可能跨模块引用：证件照属个人信息、证明材料属素材记录；不建议挂 sensitiveInfo 1:1 聚合）。

| 列 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `category` | String | 否 | 用途：ID_PHOTO / AWARD_PROOF / OTHER（受控字符串，服务层校验） |
| `materialItemId` | String? | 是 | 关联素材记录（如获奖证明）；`onDelete: SetNull`（材料归档不删附件，防未来物理删除悬空） |
| `fileName` / `mimeType` / `sizeBytes` | String / String / Int? | 否/否/是 | `fileName` 仅存展示名，不信任为路径 |
| `storageKey` | String | 否 | 相对 UPLOADS_DIR 的逻辑键（参照 ResumeArtifact.storageKey 模式），服务端重建物理路径 |
| `origin` / `archivedAt` / 时间戳 | — | — | 沿用材料惯例 |

- 【建议方案】字节存储：新目录 `UPLOADS_DIR/files/career-attachments/<id>-<safeName>`，不复用 `files/resumes`（`isResumeFilePath` 约束保持原义）；下载/读取走服务端路由，按 `assertCareerDataReadable` 闸门。
- 【待决策 D16：校验与体积】推荐：证件照接受 png/jpg（需扩展 `sniffFileType` 当前仅 pdf/docx），证明材料接受 pdf/jpg/png；单文件上限建议 5MB 对齐 `MAX_RESUME_FILE_SIZE_BYTES`，或由 Owner 定。
- 【待决策 D17：敏感分级】推荐**整表 `dataset: "sensitive"`**：证件照与证明人同级敏感；获奖证明虽敏感度较低，但同表分级复杂且收益小——统一敏感边界最简单（标准备份不含，敏感备份含）。
- 【建议方案】删除语义：`archivedAt` 归档（行可恢复）；字节清理为后续任务，本合同不要求物理删除文件（与 File/backup `fileMissing` 模式一致：行在、文件可缺）。

示例（证件照）：

```json
{
  "category": "ID_PHOTO",
  "materialItemId": null,
  "fileName": "id-photo.jpg",
  "storageKey": "career-attachments/<uuid>/id-photo.jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 81233
}
```

## 4. 派生值合同（最高学历 / 学校城市 / 毕业届次）

【已有事实】规格 3.1：三者"不再在个人信息中另行手工维护，由教育经历关联/派生并供网申使用"。现有 `CandidateProfile.graduationCohort` 为手工列，CP-EDIT 已作为 11 个直接编辑字段之一上线。

【建议方案】派生源：当前用户 `type=EDUCATION` 且 `archivedAt: null` 的全部 `CareerMaterialItem`。

【建议方案】选记录规则（多记录 → 单条"主学历"）：

1. 候选按学位等级权重降序；权重相等按毕业时间（`graduationOn ?? endDate`）降序；再按 `updatedAt` 降序保证确定性。
2. 学位权重依赖受控词表（D5）：建议 `博士后(6) > 博士(5) > 硕士/MBA(4) > 本科(3) > 大专(2) > 其他/未知(0)`；非词表历史值按 0 处理，**不做字符串模糊匹配推断**。
3. 【待决策 D5 附项：在读处理】推荐 A：仅 `isCurrent=false`（已毕业）记录参与"最高学历"；无已毕业记录时展示最高学位的在读记录并在网申侧标注"在读"。备选 B：在读直接参与排序（在读博士 > 已毕业硕士，可能高估）。推荐 A 理由：网申"最高学历"通常指已获得学历。
4. 学校城市 = 选中记录的 `locationText` **原样透出**，不做城市归一化/翻译。
5. 毕业届次 = 选中记录的毕业年份（`graduationOn` 年份；缺省回退 `endDate` 年份；再缺回退 `CandidateProfile.graduationCohort` 手工列兜底）。
6. `graduationCohort` 手工列【建议方案】：**保留列与历史值，作为无教育记录时的兜底**；派生值存在时一律优先；UI 从 11 个直接编辑字段中改为只读"派生"展示（或保留手工编辑仅当无教育记录 → D5 附项）。不建议删列或 UPDATE 重写历史值。
7. 派生结果**只在读取层组装**（service/projection DTO），不回写任何列——避免双份事实。

示例：

```text
教育记录：本科(2020-2024, isCurrent=false, locationText="武汉", graduationOn="2024-06-30")
          硕士(2024-2027, isCurrent=true,  locationText="北京")
派生：最高学历=本科（已毕业最高学位）；学校城市=武汉；毕业届次=2024
```

## 5. 既有模型增量列提案（M1 候选基线）

**以下为本提案建议基线（非已批准的"35 列"清单，见文首声明）。** 逐列均为 `NULL`/`default` 增量，不 backfill。

| 目标模型 | 建议新列 | 类型 | 依据 |
| --- | --- | --- | --- |
| CandidateProfile | `countryOrRegion` | String? | 规格：国家/地区 |
| CandidateProfile | `wechatId` | String? | 规格：微信号 |
| CandidateProfile | `qqNumber` | String? | 规格：QQ号 |
| CandidateProfile | `currentCity` | String? | 规格：当前所在地 |
| CandidateProfile | `homeCity` | String? | 规格：家庭所在城市 |
| CandidateProfile | `homeAddress` | String? | 规格：家庭常驻地址（address 保留既有语义，D4） |
| CandidateProfile | `phoneCountryCode` | String? | 区号拆分（仅当 D3 选拆分） |
| CandidateSensitiveInfo | `idType` | String? | 证件类型（与 idNumber 同敏感边界） |
| CareerEducationDetail | `currentStudyLocation` | String? | 目前就读地 |
| CareerEducationDetail | `department` | String? | 院系/学院 |
| CareerEducationDetail | `majorCategory` | String? | 专业类别 |
| CareerEducationDetail | `studyMode` | String? | 学习形式 |
| CareerEducationDetail | `isExchange` | Boolean @default(false) | 是否交换经历 |
| CareerEducationDetail | `graduationOn` | String? (DateOnly) | 毕业时间；TEXT 非 DateTime |
| CareerEducationDetail | `graduationExpected` | Boolean @default(false) | 预计毕业标记（或并入 endDate/isCurrent → D6） |
| CareerEducationDetail | `rankClassText` / `rankMajorText` | String? | 班级/专业排名（仅当 D7 选拆分；rankText=成绩排名） |
| CareerEducationDetail | `hasNationalScholarship` | Boolean @default(false) | 国家奖学金 |
| CareerEducationDetail | `advisorName` / `labName` / `researchDirection` | String? | 科研信息内嵌（仅当 D8 选 A） |
| CareerInternshipDetail | `department` | String? | 部门 |
| CareerProjectDetail | `projectType` | String? | 项目类型 |
| CareerProjectDetail | `techStack` | String? | 所用技术（仅当 D10 需要结构化列） |
| CareerPublicationDetail | `venueLevel` | String? | 等级（会议/期刊级别） |
| CareerPublicationDetail | `authorRole` | String? | 作者身份（第一/第二/通讯…） |
| CareerAwardDetail | `awardType` | String? | 奖项类型 |
| CareerAwardDetail | `awardLevel` | String? | 等级（对齐竞赛 detail） |
| CareerAwardDetail | `awardScope` | String? | 个人/团队 |
| CareerCertificationDetail | `credentialId` | String? | 证书编号 |
| 新表 | `CareerLanguageDetail` | §3.1 | M2 |
| 新表 | `CandidateReferee` | §3.2 | M2 |
| 新表 | `CandidateAttachment` | §3.3 | M2 |

列数视决策约 23–30 列 + 3 表，与"35 列"口径存在差异属预期（清单来源未定位，D1）。

【建议方案·结构化边界】`structuredData` 继续只承载 provenance/未知导入字段；**规格内字段一律走具名列**（白名单校验、复制合同、派生都依赖列）。叙述性大字段（实习职责、项目背景）优先 notes+evidence（D10）。

## 6. Migration 兼容方案与历史数据处理

【建议方案】单条 additive migration（建议名 `<ts>_career_v1_schema_contract`）：

- `ALTER TABLE … ADD COLUMN`：全部 `NULL` 或字面 default（`false`/`"{}"`）；日期语义列一律 `TEXT`（`*On`），不用 DateTime。
- `CREATE TABLE`：`CareerLanguageDetail`、`CandidateReferee`、`CandidateAttachment`；`User` 与 `CareerMaterialItem`/`CandidateSensitiveInfo` 增加 back-relation。
- 索引沿用惯例：detail `materialItemId @unique`；`CandidateReferee @@index([sensitiveInfoId, sortOrder])`；`CandidateAttachment @@index([userId, materialItemId])`。
- 外键：`CareerLanguageDetail.materialItemId → CareerMaterialItem Cascade`（同 12 个 detail）；`CandidateReferee.sensitiveInfoId → CandidateSensitiveInfo Cascade`（同 familyMember，若 D14 选 A）；`CandidateAttachment.userId → User Restrict`、`materialItemId → SetNull`。
- **不 UPDATE、不 backfill、不重建既有表** → AIConnection 部分唯一索引不受影响；迁移后跑 `npm run db:verify-migration-invariants` 作为只读门。
- 历史数据：新列全 NULL；`graduationCohort`/`JobSearchPreference`/legacy 表原值不动；既有 `CareerEvidence` Restrict 语义不变。
- 与 Phase 3 backfill 关系：本次不触发旧数据重迁移；LegacyMigrationMap 幂等键不变；新列对既有材料为 NULL（合法态）。
- 敏感存储口径【已有事实】：现有提示"本地存储，未加密"（sensitiveLocalTitle）；新增敏感对象与附件字节同等级声明，**加密不在本轮范围**。
- 失败恢复：additive 迁移可重复 deploy；`--create-only` 生成 SQL 须人工审查（不变量文档要求）。

## 7. 备份格式影响提案（Backup V5，不修改备份代码）

【已有事实】见 §1.3；以下为**提案**，实施归 Schema/Integration Owner。

【建议方案】备份变更点：

| 文件 | 建议变更 | 理由 |
| --- | --- | --- |
| `backup/schema.ts` | `BACKUP_FORMAT_VERSION=5`；`SUPPORTED`+`literal(5)`；新增 3 个 row schema 与 group；既有 row schema 补新列（`.optional()`） | 新列必须进 row schema，否则导出被 zod 剥离（静默丢数据） |
| `backup/ordering.ts` | `BackupModel` union +3；`MODEL_SPECS`：`CareerLanguageDetail{scope: byMaterial}`、`CandidateReferee{scope: bySensitiveInfo（D14 A）或 byUser, dataset:"sensitive"}`、`CandidateAttachment{scope: byUser, dataset:"sensitive"}`；`INSERT_ORDER` 按父先子后插入 | 覆盖守护测试要求显式分类 |
| `backup/compat.ts` | `normalizeManifest` v5 分支同 v3/v4（要求 `containsSensitiveData`）；敏感 key 集由 ordering 派生自动覆盖 | 标准备份出现敏感组即报错 |
| `backup/export.ts` | 附件字节：参照 File，条目 `career-attachments/<id>/<safeName>` + `bytesMissing` 标记；**仅敏感备份内嵌** | D16/D17 决策后落地 |
| `backup/import.ts` | 无需结构改动：mint ids 遍历 INSERT_ORDER、dataset 过滤自动生效；新对象是否入 `EMPTINESS_MODELS` → D18 | 建议 referee/attachment 计入非空判定 |
| `backup/coverage.ts` | 无需改（新模型必须有分类，否则 guard 失败） | — |

兼容矩阵【建议方案】：

| 场景 | 结果 |
| --- | --- |
| 新版恢复 v1–v4 备份 | 缺失 group 默认 `[]`、缺失列 `.optional()` → 兼容 |
| 旧版恢复 v5 备份 | `ManifestSchema` literal 拒绝 → 明确版本错误，先 fail-safe 不写数据 |
| 新版导出但未同步 row schema | 新列被剥离 → **必须作为开发包验收项拦截** |
| 标准（非敏感）备份 | 不含 referee/attachment/sensitiveInfo 行与附件字节；恢复时也不 wipe 敏感表（`modelsForWipe(false)` 自动过滤） |

## 8. 敏感信息、复制与导出边界

【已有事实】`PERSONAL_INFO_COPY_FIELDS` 白名单构造上排除敏感字段；`assertNoSensitiveKeysWhenStandard` 阻止敏感组进标准备份；紧急联系人走 掩码/reveal/字段级 copy 模式；i18n 已声明"不会发送给 AI，普通备份默认不含"。

【建议方案】边界定义（冻结供 CP-PRIVACY/CP-COPY 使用）：

| 对象 | 敏感边界 | 批量复制 | 字段级复制 | 备份 | AI |
| --- | --- | --- | --- | --- | --- |
| 证件类型/号码/证件照 | 敏感 | 永不进白名单 | 专属 action 显式调用 | dataset sensitive | 不提供 |
| 紧急联系人 | 敏感（已有） | 同上 | 同上 | 同上 | 同上 |
| 证明人 | 敏感 | 同上 | 同上 | 同上 | 同上 |
| 附件（文件字节+元数据） | 敏感 | 同上（字节不可复制） | 下载需显式操作 | 同上 | 同上 |
| 个人信息其余新列（国家/微信/QQ/城市等） | 非敏感 | 显式加白名单后允许 | 通用字段复制 | dataset standard | 按现有投影范围 |
| 语言/科研/论文等新材料 | 非敏感 | 进入对应记录/Tab/汇总复制 | 通用 | standard | 同现有材料 |

- 网申投影：敏感对象不进 `getApplicationProjection` 返回体；新字段按上表纳入。
- 复制文本层（`applicationCopy.ts`）只允许白名单增长；任何敏感键加入视为回归。

## 9. 开发包分工与文件 Owner

依赖序：PKG-1 冻结字段合同 → PKG-2/3 并行 → PKG-4/5/6 随后。CP-UI/EDIT/RECORDS 现有字段部分**可在冻结前继续**（轨道 B 既有结论）。

| 包 | 范围 | 文件 Owner（唯一写者） | 依赖 |
| --- | --- | --- | --- |
| PKG-1 CP-SCHEMA | schema.prisma 增量列+3 表、新 Migration、迁移不变量验证 | **Schema/Integration Owner**：`prisma/schema.prisma`、`prisma/migrations/<ts>_*`、`__tests__` 相关 schema spec | 本文档冻结（D1–D18 中 schema 相关项） |
| PKG-2 CP-BACKUP-V5 | 备份格式 V5（§7 全部） | **同一 Schema/Integration Owner**：`src/lib/backup/*` + backup specs | PKG-1 |
| PKG-3 CP-CAREER-SVC | LANGUAGE type、白名单、detail include、新对象 service、派生读取 | Career Service Owner：`src/lib/career/{identities,careerMaterialInput,careerMaterialService,candidateProfileService}.ts`、新 `candidateRefereeService.ts`/`candidateAttachmentService.ts` | PKG-1 |
| PKG-4 CP-PROFILE-UI | 个人信息新字段行、证明人/附件卡、语言条目 UI | Career UI Owner：`src/components/career/application-profile/*`、`src/actions/applicationProfile.actions.ts`、`src/actions/careerProfileTabs.actions.ts` | PKG-3 |
| PKG-5 CP-COPY-PRIVACY | 复制白名单、掩码扩展、投影新字段 | 与 PKG-4 共享 `applicationCopy.ts`/workspace → **同一 Owner 或顺序交接** | PKG-3/4 |
| PKG-6 CP-I18N | 全部新文案 | i18n Owner：`src/i18n/messages/{en,zh-CN}.json` | 随各包分批 |
| PKG-7 CP-DERIVED | 派生值 service+投影消费（§4） | Career Service Owner（读取函数）+ Career UI Owner（展示） | PKG-3 |

【建议方案】共享文件约束：PKG-4 与 PKG-5 触及相同 UI/复制文件，按 AGENTS 单一 Owner 规则指派一人或顺序交接；`sensitiveMask.ts`/`applicationCopy.ts` 由 PKG-5 先落地接口，UI 包消费。

## 10. 待决策汇总

| # | 决策项 | 推荐 | 理由 |
| --- | --- | --- | --- |
| D1 | M1/M2 精确清单来源 | 以本提案 §2/§3/§5 为候选冻结基线，Owner 确认或提供外部清单逐项替换 | 仓库未定位"35 列"清单，不能把推测写成已批准合同 |
| D2 | 性别枚举 | 扩枚举接受"保密"，保留"其他"兼容历史值（规格 男/女/保密 与现有 男/女/其他 取并集） | 不改写历史数据；与校验集共存 |
| D3 | 手机区号 | 新增 `phoneCountryCode` 独立列，phone 存号码主体；紧急联系人电话保留单列 | 规格分控件；紧急电话"按需"不强制拆分 |
| D4 | 地址语义 | 新增 `homeAddress`；`address` 保留为历史简历联系地址语义，不迁移语义 | 规格禁止地点语义互相替代 |
| D5 | 学位词表与派生 | 受控词表 + §4 排序规则；在读不参与"最高学历"；`graduationCohort` 保留作兜底 | 派生必须可重现；不改写历史 |
| D6 | 毕业时间字段 | 新列 `graduationOn`(DateOnly TEXT) + `graduationExpected`；不复用 endDate | 规格区分结束时间与毕业时间；DateOnly 无时区歧义 |
| D7 | 排名 | 保留 `rankText`（成绩排名），新增 `rankClassText`/`rankMajorText` | 规格明确三类排名；不动已有列 |
| D8 | 科研信息归属 | EducationDetail 内嵌 `advisorName/labName/researchDirection`；RESEARCH 类型保留为独立科研经历 | 规格按"关联教育记录"建模；两者语义不冲突 |
| D9 | 作品/主页 | 复用 `CandidateProfile.linksData`（JSON）接 UI，不新建类型 | 已有列就是为链接集合预留；避免新表 |
| D10 | 叙述字段 | 实习职责/项目背景等走 `notes`+`CareerEvidence`，不新增大文本列；仅 `techStack` 可选列 | evidence 已承载量化/事实点，列留给结构化字段 |
| D11 | 教育关联奖项 | 不做记录级关联，获奖独立录入；文档提示用户避免冲突录入 | 规格明示留待实现设计；关联模型本轮不冻结 |
| D12 | AI 应用技能 | 复用 SKILL 类型 + `skillName/proficiency`；"应用场景/经验"入 notes/evidence | 不新增平行类型；语义可承载 |
| D13 | 语言载体 | 新 type `LANGUAGE` + `CareerLanguageDetail` | §3.1 |
| D14 | 证明人归属 | 挂 `CandidateSensitiveInfo`（同 familyMember） | 敏感边界单点成立，备份/掩码自动继承 |
| D15 | 证明人编辑语义 | 单条 CRUD + archivedAt | 与多条记录验收口径一致 |
| D16 | 附件校验 | png/jpg/pdf，5MB 上限，`sniffFileType` 需扩展图片 | 与现有上传约束对齐 |
| D17 | 附件敏感分级 | 整表 sensitive | 边界最简、覆盖证件照 |
| D18 | 附件入 EMPTINESS_MODELS | 计入（referee/attachment），languageDetail 不必 | 恢复前快照/确认语义完整 |

## 11. 冻结后施工注意

- 写路径：`APPLICATION_PROFILE_DETAIL_FIELDS` 与 `materialFields.ts` 必须镜像新增（含 `LANGUAGE` 新类型）；`FORBIDDEN_DETAIL_KEYS` 不变。
- `careerMaterialService.fullDetailInclude/detailCreateKey` 需补 `languageDetail`。
- `PERSONAL_INFO_COPY_FIELDS` 只加非敏感新列；敏感对象复制走专属 action。
- 备份 row schema 与新列同步为硬验收（防 zod 剥离静默丢数据）。
- 任何物理删除路径都不新增；"删除"=归档。
