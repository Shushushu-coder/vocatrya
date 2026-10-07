import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";

const schema = path.resolve("prisma/schema.prisma");
const prismaCli = path.resolve("node_modules/prisma/build/index.js");
const migrationDir = path.resolve("prisma/migrations");
const summaryMigration = path.join(
  migrationDir,
  "20261003120000_conversation_summary",
  "migration.sql",
);

function fileUrl(file: string): string {
  return `file:${file.replace(/\\/g, "/")}`;
}

function runPrisma(args: string[], databaseUrl: string) {
  execFileSync(process.execPath, [prismaCli, ...args, "--schema", schema], {
    cwd: path.resolve("."),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
}

describe("ConversationSummary migration", () => {
  const directories: string[] = [];

  afterAll(() => {
    for (const directory of directories) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates only the cache table and leaves ChatConversation columns alone", () => {
    const sql = readFileSync(summaryMigration, "utf8");
    expect(sql).toContain('CREATE TABLE "ConversationSummary"');
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).toContain('CREATE INDEX "ConversationSummary_userId_idx"');
    expect(sql).not.toMatch(/ALTER TABLE "ChatConversation"/);
    expect(sql).not.toMatch(/UPDATE "ChatConversation"/);
    expect(sql).not.toMatch(/INSERT INTO "ConversationSummary"/);
  });

  it("upgrades an existing conversation database without backfill and cascades deletes", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "vocatrya-summary-migrate-"));
    directories.push(directory);
    const database = path.join(directory, "upgrade.db");
    const url = fileUrl(database);
    const folders = [
      "20240524022540_init",
      "20240528002543_add_string_id_to_user",
      "20240604110546_add_label_and_value",
      "20240612084946_add_joburl_and_applied_fields",
      "20240624230528_add_profile_resume_models",
      "20240627061730_update_resume_section_and_summary_relationship",
      "20241103213832_resume_upload",
      "20241210004820_add_activity_and_activty_type_table",
      "20260113163354_add_task_model",
      "20260130042742_add_automations",
      "20260131063928_add_user_settings",
      "20260212202940_add_createdby_to_jobsource",
      "20260216_multi_user_unique_constraints",
      "20260217_add_location_unique_constraint",
      "20260219201822_apply",
      "20260302223041_add_note_model",
      "20260303014226_add_tag_model",
      "20260305175020_add_question_model",
      "20260326034736_add_cover_letter",
      "20260626144202_add_mcp_access_token",
      "20260627071346_add_skill_section",
      "20260628080148_add_automation_source_config",
      "20260628161416_add_contact_info_urls",
      "20260628161718_add_contact_info_url_labels",
      "20260701071535_add_question_created_via",
      "20260702153647_add_user_default_resume",
      "20260707151433_add_workplace_type_to_job",
      "20260710000001_automation_run_single_active",
      "20260710000002_job_automation_url_unique",
      "20260711003153_activity_task_one_to_many",
      "20260712184644_add_resume_review_data",
      "20260722065252_job_description_completeness",
      "20260802221904_chat_conversation",
      "20260813075758_add_activity_breaks",
      "20260904000000_job_status_offer_outcomes",
      "20260904120000_remove_jsearch_rapidapi",
      "20260907153300_company_watchlist",
      "20260912131248_contacts",
      "20260912170952_contact_default_role",
      "20260916171642_add_vocatrya_ab_foundation",
      "20260917120000_add_ab_migration_state",
      "20260918120000_add_process_step_deadline_at",
      "20260918130000_add_campus_core_fields",
      "20260918140000_add_interview_reflection_items",
      "20260918150000_rename_resume_contact_profile_to_candidate_profile",
      "20260922000000_phase3a_interview_schema",
      "20260923000000_phase_account_login_connection_foundation",
      "20260925040704_add_chat_conversation_ai_lock",
      "20261001120000_chat_conversation_multi",
    ];
    // Replay the pre-summary schema in-process: spawning `prisma db execute`
    // per migration folder costs ~45 serialized CLI launches and blows the
    // test timeout under suite parallelism. db.execute applies raw SQL with
    // no _prisma_migrations bookkeeping, which DatabaseSync.exec reproduces.
    const legacyDb = new DatabaseSync(database);
    try {
      for (const folder of folders) {
        legacyDb.exec(
          readFileSync(path.join(migrationDir, folder, "migration.sql"), "utf8"),
        );
      }
      legacyDb.exec(
        [
          `INSERT INTO "User" ("id", "name", "email", "password", "createdAt")`,
          `VALUES ('user-old', 'Historical', 'historical@example.com', 'hash', CURRENT_TIMESTAMP);`,
          `INSERT INTO "ChatConversation" ("id", "userId", "messages", "createdAt", "updatedAt")`,
          `VALUES ('conv-old', 'user-old', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);`,
        ].join("\n"),
      );
      legacyDb.exec(readFileSync(summaryMigration, "utf8"));
    } finally {
      legacyDb.close();
    }

    const freshDir = mkdtempSync(path.join(tmpdir(), "vocatrya-summary-fresh-"));
    directories.push(freshDir);
    const freshDatabase = path.join(freshDir, "fresh.db");
    writeFileSync(freshDatabase, "");
    const freshUrl = fileUrl(freshDatabase);
    runPrisma(["migrate", "deploy"], freshUrl);

    const prisma = new PrismaClient({ datasourceUrl: freshUrl });
    const upgraded = new PrismaClient({ datasourceUrl: url });
    return Promise.all([
      (async () => {
        const rows = await upgraded.$queryRawUnsafe<Array<{ id: string; messages: string }>>(
          `SELECT "id", "messages" FROM "ChatConversation"`,
        );
        expect(rows).toEqual([{ id: "conv-old", messages: "[]" }]);
        const summaries = await upgraded.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT COUNT(*) AS count FROM "ConversationSummary"`,
        );
        expect(Number(summaries[0]?.count ?? 0)).toBe(0);
      })(),
      (async () => {
        await prisma.user.create({
          data: {
            id: "user-new",
            name: "Synthetic",
            email: "synthetic@example.com",
            password: "hash",
          },
        });
        await prisma.chatConversation.create({
          data: { id: "conv-new", userId: "user-new", messages: "[]" },
        });
        expect(await prisma.conversationSummary.findUnique({ where: { conversationId: "conv-new" } })).toBeNull();
        await prisma.conversationSummary.create({
          data: { conversationId: "conv-new", userId: "user-new", revision: 0 },
        });
        await prisma.chatConversation.delete({ where: { id: "conv-new" } });
        expect(await prisma.conversationSummary.findUnique({ where: { conversationId: "conv-new" } })).toBeNull();
        const surviving = await prisma.chatConversation.create({
          data: { id: "conv-kept", userId: "user-new", messages: "[]" },
        });
        expect(surviving.messages).toBe("[]");
        expect(surviving.resolvedConnectionId).toBeNull();
        expect(surviving.resolvedModel).toBeNull();
      })(),
    ]).finally(async () => {
      await prisma.$disconnect();
      await upgraded.$disconnect();
    });
  }, 120_000);
});