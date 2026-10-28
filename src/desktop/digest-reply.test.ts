import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getTopic, saveTopic, softDeleteTopic } from "../storage/local-store.js";
import { listJobs } from "../modules/research/research-job-store.js";
import { handleDigestReply, type DigestReplyDeps } from "./digest-reply.js";
import { saveDigestState, type DigestState } from "./digest-state.js";

const CHAT = 8800;
const NOW = new Date(2026, 8, 7, 10, 0, 0).getTime();

let tmp: string;
let replies: string[];
let topicA: string;
let topicB: string;

const settings = { botToken: "123:abc", allowedUserIds: ["7"], targetWorkspaceId: "default" };

function deps(over: Partial<DigestReplyDeps> = {}): DigestReplyDeps {
  return {
    settings,
    dataDir: tmp,
    now: () => NOW,
    reply: async (_chatId: number, text: string) => {
      replies.push(text);
      return true;
    },
    ...over,
  };
}

async function seed(over: Partial<DigestState> = {}): Promise<void> {
  await saveDigestState(
    {
      lastSentDate: "2026-09-07",
      lastSentAt: new Date(NOW - 3600_000).toISOString(),
      lastDigest: {
        date: "2026-09-07",
        sentAt: new Date(NOW - 3600_000).toISOString(),
        items: [
          { n: 1, topicId: topicA, title: "甲选题" },
          { n: 2, topicId: topicB, title: "乙选题" },
        ],
      },
      ...over,
    },
    tmp,
  );
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-digest-reply-"));
  replies = [];
  topicA = (await saveTopic({ title: "甲选题", description: "", tags: [] }, tmp)).id;
  topicB = (await saveTopic({ title: "乙选题", description: "", tags: [] }, tmp)).id;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("摘要回复（spec §2.4）", () => {
  it("不是纯数字 → 不拦截（照常进灵感入账）", async () => {
    await seed();
    expect(await handleDigestReply({ text: "想做一期讲选题的", chatId: CHAT }, deps())).toBe(false);
    expect(replies).toHaveLength(0);
  });

  it("盘上没有清单时，数字也只是一条随手记", async () => {
    expect(await handleDigestReply({ text: "3", chatId: CHAT }, deps())).toBe(false);
    expect(replies).toHaveLength(0);
  });

  it("回 0 → 「好，今天不动」，不碰选题", async () => {
    await seed();
    expect(await handleDigestReply({ text: "0", chatId: CHAT }, deps())).toBe(true);
    expect(replies).toEqual(["好，今天不动"]);
    expect((await getTopic(topicA, tmp))?.topicMeetingRequestedAt).toBeUndefined();
  });

  it("回范围内的数字 → 选题标「待开选题会」，回执让人去 Claude 会话开选题会，不起任何调研任务", async () => {
    await seed();
    expect(await handleDigestReply({ text: " 2 ", chatId: CHAT }, deps())).toBe(true);
    expect(replies).toEqual([`已记下《乙选题》，到 Claude 会话里说『给《乙选题》开选题会（选题 ${topicB}）』`]);
    const topic = await getTopic(topicB, tmp);
    expect(topic?.topicMeetingRequestedAt).toBe(new Date(NOW).toISOString());
    expect(topic?.renewedAt).toBe(new Date(NOW).toISOString());
    expect(await listJobs(tmp)).toEqual([]);
  });

  it("同一个数字再回一次 → 同一句回执，不出错", async () => {
    await seed();
    await handleDigestReply({ text: "1", chatId: CHAT }, deps());
    expect(await handleDigestReply({ text: "1", chatId: CHAT }, deps())).toBe(true);
    expect(replies).toEqual([
      `已记下《甲选题》，到 Claude 会话里说『给《甲选题》开选题会（选题 ${topicA}）』`,
      `已记下《甲选题》，到 Claude 会话里说『给《甲选题》开选题会（选题 ${topicA}）』`,
    ]);
  });

  it("超范围 → 明说范围", async () => {
    await seed();
    await handleDigestReply({ text: "12", chatId: CHAT }, deps());
    expect(replies).toEqual(["清单里只有 1–2"]);
  });

  it("选题已进回收站 → 照实说没法记下，不改它", async () => {
    await seed();
    await softDeleteTopic(topicA, tmp);
    await handleDigestReply({ text: "1", chatId: CHAT }, deps());
    expect(replies[0]).toContain("已经不在灵感库里了");
    expect((await getTopic(topicA, tmp))?.topicMeetingRequestedAt).toBeUndefined();
  });

  it("回的是旧清单 → 回执带上那份的日期", async () => {
    const old = await saveTopic({ title: "昨天那条", description: "", tags: [] }, tmp);
    await seed({
      lastDigest: {
        date: "2026-09-06",
        sentAt: new Date(NOW - 26 * 3600_000).toISOString(),
        items: [{ n: 1, topicId: old.id, title: "昨天那条" }],
      },
    });
    await handleDigestReply({ text: "1", chatId: CHAT }, deps());
    expect(replies[0]).toContain("（这是 9 月 6 日的清单）");
    expect(replies[0]).toContain("已记下《昨天那条》");
  });

  it("拿不到 chatId 也算处理过——「3」不该变成一条灵感", async () => {
    await seed();
    expect(await handleDigestReply({ text: "1" }, deps())).toBe(true);
    expect(replies).toHaveLength(0);
  });
});
