import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBot } from "../src/bot";
import type { AppConfig } from "../src/config";
import type { CocoaReportService } from "../src/services/cocoa-report";
import { UsageStatisticsService } from "../src/services/usage-statistics";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cocoa-statistics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "data", "usage.json");
  return { path, statistics: await UsageStatisticsService.open(path) };
}

test("counts concurrent calls, deduplicates updates, refreshes profiles and survives restart", async (t) => {
  const { path, statistics } = await fixture(t);
  await Promise.all([
    statistics.record({ updateId: 10, command: "start", user: { id: 1, firstName: "A", username: "old" }, chat: { id: 1, type: "private" } }),
    statistics.record({ updateId: 11, command: "cocoa", user: { id: 1, firstName: "B" }, chat: { id: -1, type: "group" } }),
    statistics.record({ updateId: 12, command: "help", user: { id: 2, firstName: "C" } }),
    statistics.record({ updateId: 13, command: "cocoa", chat: { id: -2, type: "channel" } }),
    statistics.record({ updateId: 11, command: "cocoa", user: { id: 1, firstName: "B" } })
  ]);
  const reopened = await UsageStatisticsService.open(path);
  const state = await reopened.snapshot();
  assert.equal(state.totalUses, 4);
  assert.equal(state.anonymousUses, 1);
  assert.deepEqual(state.commands, { start: 1, help: 1, cocoa: 2 });
  assert.equal(Object.keys(state.users).length, 2);
  assert.equal(state.users[1].uses, 2);
  assert.equal(state.users[1].username, undefined);
  assert.equal(state.users[1].firstName, "B");
  assert.equal(Object.keys(state.chats).length, 3);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  state.users[1].uses = 99;
  assert.equal((await reopened.snapshot()).users[1].uses, 2);
});

test("does not overwrite corrupt data", async (t) => {
  const { path } = await fixture(t);
  await writeFile(path, "broken json");
  await assert.rejects(UsageStatisticsService.open(path));
  assert.equal(await readFile(path, "utf8"), "broken json");
  const invalid = JSON.stringify({
    version: 1, totalUses: 0, anonymousUses: 0, commands: { start: 0, help: 0, cocoa: 0 },
    users: { "1": { id: 1 } }, chats: {}, recentUpdateIds: [], startedAt: "now"
  });
  await writeFile(path, invalid);
  await assert.rejects(UsageStatisticsService.open(path));
  assert.equal(await readFile(path, "utf8"), invalid);
});

test("failed writes do not count and the queue recovers", async (t) => {
  const { path, statistics } = await fixture(t);
  const original = await readFile(path, "utf8");
  await rm(join(path, ".."), { recursive: true });
  await assert.rejects(statistics.record({ updateId: 1, command: "cocoa" }));
  assert.equal((await statistics.snapshot()).totalUses, 0);
  // Recreate the directory using a second service, then retry on the original writer.
  await UsageStatisticsService.open(path);
  await writeFile(path, original);
  await statistics.record({ updateId: 1, command: "cocoa" });
  assert.equal((await statistics.snapshot()).totalUses, 1);
});

test("bot tracks only supported allowed commands and restricts profile export to private admins", async (t) => {
  const { statistics } = await fixture(t);
  const config = { botToken: "123:test", adminUserIds: new Set([1]), allowedChatIds: new Set([1, 2, -1, -2]) } as AppConfig;
  let reportCalls = 0;
  const reportService = { buildReport: async () => { reportCalls += 1; throw new Error("source unavailable"); } } as unknown as CocoaReportService;
  const bot = createBot(config, reportService, statistics);
  bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "cocoa_test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false };
  const replies: Array<{ method: string; payload: any }> = [];
  bot.api.config.use(async (_previous, method, payload) => {
    replies.push({ method, payload });
    return { ok: true, result: {} } as any;
  });
  let updateId = 0;
  async function send(text: string, userId = 1, chatId = userId, senderChat = false) {
    await bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: updateId, date: 1,
        chat: chatId < 0 ? { id: chatId, type: "supergroup", title: "Group" } : { id: chatId, type: "private", first_name: "User" },
        from: { id: userId, is_bot: false, first_name: "User", username: "test_user", language_code: "ru" },
        ...(senderChat ? { sender_chat: { id: chatId, type: "supergroup" as const, title: "Group" } } : {}),
        text
      }
    });
  }
  await send("/start");
  await send("/help", 1, -1);
  await send("/cocoa");
  await send("/cocoa 123");
  await send("/cocoa", 1, -1, true);
  await send("hello");
  await send("/unknown");
  await send("/cocoa@another_bot");
  await send("/start", 3);
  await send("/stats users", 2);
  await send("/stats users", 1, -1);
  assert.equal(replies.some((reply) => reply.method === "sendDocument"), false);
  await send("/stats users");
  assert.equal(replies.filter((reply) => reply.method === "sendDocument").length, 1);
  await send("/stats");
  assert.match(replies.at(-1)!.payload.text, /Всего использований: 5/);
  assert.match(replies.at(-1)!.payload.text, /Уникальных пользователей: 1/);
  const state = await statistics.snapshot();
  assert.equal(state.totalUses, 5);
  assert.equal(state.anonymousUses, 1);
  assert.equal(state.users[1].uses, 4);
  assert.equal(reportCalls, 2);
});
