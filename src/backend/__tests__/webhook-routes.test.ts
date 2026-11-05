import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { createErrorHandler } from "../error-handler.js";
import { MAX_BATCH_SIZE } from "../index-event.js";
import { createIndexJobHandler, type IndexJob } from "../index-job.js";
import { InMemoryJobQueue, type JobQueue } from "../job-queue.js";
import { createMockEmbedder } from "../embeddings.js";
import { createInMemoryVectorStores } from "../vector-store.js";
import { RECORD_TYPES } from "../record-type.js";
import {
  InMemoryReplayGuard,
  RedisReplayGuard,
  type ReplayGuard,
  type ReplayRedisClient,
} from "../replay-guard.js";
import {
  HMAC_TIMESTAMP_TOLERANCE_SECONDS,
  REPLAY_WINDOW_SECONDS,
  WEBHOOK_IDEA_APPROVED_PATH,
  WebhookConfigError,
  installBodyParsers,
  loadWebhookHmacSecrets,
  type WebhookDependencies,
} from "../webhook-routes.js";

const DIMS = 16;
const SECRET_1 = "webhook-secret-number-one-0001";
const SECRET_2 = "webhook-secret-number-two-0002";

/** Ký body giống VNAIP BE: HMAC-SHA256(secret, `${timestamp}.${rawBody}`). */
function signatureHeaders(
  secret: string,
  rawBody: string,
  timestampSeconds: number | string,
): Record<string, string> {
  const signature = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest("hex");
  return {
    "x-webhook-timestamp": String(timestampSeconds),
    "x-webhook-signature": `sha256=${signature}`,
  };
}

const validEvent = {
  id: "GP-1",
  type: "solutions",
  title: "MARKER-TITLE ứng dụng báo cáo sự cố",
  content: "MARKER-CONTENT nội dung sáng kiến cần được index.",
};

interface SetupOverrides {
  queue?: JobQueue<IndexJob>;
  unconfigured?: boolean;
  replayGuard?: ReplayGuard;
  now?: () => Date;
  authNow?: () => Date;
}

async function setup(overrides: SetupOverrides = {}) {
  const logs: Array<Record<string, unknown>> = [];
  const log = (level: string, event: string, details: Record<string, unknown>) => {
    logs.push({ level, event, ...details });
  };
  // Ba kho, mỗi type một collection; `store` là collection "solutions", type của validEvent.
  const stores = createInMemoryVectorStores(DIMS);
  const store = stores.forType("solutions");
  const queue = new InMemoryJobQueue<IndexJob>();
  await queue.startConsuming(
    createIndexJobHandler(
      { embed: createMockEmbedder(DIMS), stores, embeddingModel: "mock", chunkChars: 100 },
      { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 10 },
      log as never,
    ),
  );

  const deps: WebhookDependencies = {
    queue: overrides.queue ?? queue,
    hmacSecrets: [SECRET_1, SECRET_2],
    replayGuard: overrides.replayGuard ?? new InMemoryReplayGuard(),
    log: log as never,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.authNow ? { authNow: overrides.authNow } : {}),
  };
  const app = express();
  // Cùng hàm với server.ts: route webhook trước parser JSON chung, nên test này
  // chạy đúng thứ tự middleware thật chứ không phải bản tự dựng.
  installBodyParsers(app, overrides.unconfigured ? null : deps);
  app.use(createErrorHandler(log as never));

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("không bind được server");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  /**
   * Gửi request đã ký bằng SECRET_1 ở timestamp hiện tại trừ khi `headers`
   * ghi đè `x-webhook-signature`/`x-webhook-timestamp` để test trường hợp lỗi.
   */
  const post = (
    body: unknown,
    headers: Record<string, string> = {},
    raw = false,
    path: string = WEBHOOK_IDEA_APPROVED_PATH,
  ) => {
    const rawBody = raw ? (body as string) : JSON.stringify(body);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signed = signatureHeaders(SECRET_1, rawBody, timestampSeconds);
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signed, ...headers },
      body: rawBody,
    });
  };

  /** Request không có header chữ ký nào, để test thiếu/sai signature. */
  const postUnsigned = (body: unknown, headers: Record<string, string> = {}, raw = false) =>
    fetch(`${baseUrl}${WEBHOOK_IDEA_APPROVED_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: raw ? (body as string) : JSON.stringify(body),
    });

  return {
    store,
    stores,
    queue,
    logs,
    post,
    postUnsigned,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const rejectedReasons = (logs: Array<Record<string, unknown>>) =>
  logs.filter((entry) => entry.event === "webhook_rejected").map((entry) => entry.reason);

test("event hợp lệ: 202, job được xử lý và chunk nằm trong store", async () => {
  const t = await setup();
  try {
    const response = await t.post(validEvent);
    const body = (await response.json()) as { status: string; jobId: string };

    assert.equal(response.status, 202);
    assert.equal(body.status, "accepted");
    assert.ok(body.jobId.length > 0);

    await t.queue.drain();
    const { points } = await t.store.scrollAll();
    assert.ok(points.length >= 1);
    assert.ok(points.every((point) => point.payload.ideaId === "GP-1"));
  } finally {
    await t.close();
  }
});

test("chấp nhận chữ ký ký bằng secret thứ hai khi đang đổi secret", async () => {
  const t = await setup();
  try {
    const event = { ...validEvent, id: "GP-2" };
    const rawBody = JSON.stringify(event);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const headers = signatureHeaders(SECRET_2, rawBody, timestampSeconds);
    const response = await t.postUnsigned(rawBody, headers, true);
    assert.equal(response.status, 202);
  } finally {
    await t.close();
  }
});

test("thiếu hoặc sai chữ ký trả 401, không enqueue và không lộ secret", async () => {
  const t = await setup();
  try {
    const missing = await t.postUnsigned(validEvent, {});

    const rawBody = JSON.stringify(validEvent);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const wrongHeaders = signatureHeaders("secret-sai-nhung-du-dai-00000000", rawBody, timestampSeconds);
    const wrong = await t.postUnsigned(rawBody, wrongHeaders, true);

    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(((await wrong.json()) as { code: string }).code, "AUTH_ERROR");

    await t.queue.drain();
    assert.equal((await t.store.scrollAll()).points.length, 0);
    assert.deepEqual(
      t.logs.filter((entry) => entry.event === "webhook_rejected").map((entry) => entry.reason),
      ["missing_signature", "invalid_signature"],
    );
    assert.equal(JSON.stringify(t.logs).includes(SECRET_1), false);
    assert.equal(JSON.stringify(t.logs).includes(SECRET_2), false);
  } finally {
    await t.close();
  }
});

test("timestamp lệch quá biên cho phép trả 401 (chống replay)", async () => {
  const t = await setup();
  try {
    const rawBody = JSON.stringify(validEvent);
    const staleTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 giờ trước
    const headers = signatureHeaders(SECRET_1, rawBody, staleTimestamp);
    const response = await t.postUnsigned(rawBody, headers, true);

    assert.equal(response.status, 401);
    assert.deepEqual(
      t.logs.filter((entry) => entry.event === "webhook_rejected").map((entry) => entry.reason),
      ["stale_timestamp"],
    );
  } finally {
    await t.close();
  }
});

test("chữ ký tính trên body khác (body bị sửa giữa đường) trả 401", async () => {
  const t = await setup();
  try {
    const timestampSeconds = Math.floor(Date.now() / 1000);
    // Ký trên body A nhưng gửi body B: giả lập proxy/MITM sửa nội dung.
    const signedForOtherBody = signatureHeaders(SECRET_1, JSON.stringify({ ...validEvent, id: "GP-OTHER" }), timestampSeconds);
    const response = await t.postUnsigned(JSON.stringify(validEvent), signedForOtherBody, true);

    assert.equal(response.status, 401);
  } finally {
    await t.close();
  }
});

test("event sai định dạng trả 400 và không enqueue", async () => {
  const t = await setup();
  try {
    const noTitle = await t.post({ ...validEvent, title: "" });
    assert.equal(noTitle.status, 400);
    assert.equal(((await noTitle.json()) as { code: string }).code, "INVALID_EVENT");

    const { id: _omitted, ...withoutId } = validEvent;
    assert.equal((await t.post(withoutId)).status, 400);
    assert.equal((await t.post([])).status, 400);
    assert.equal((await t.post("text")).status, 400);
    assert.equal((await t.post(null)).status, 400);

    await t.queue.drain();
    assert.equal(t.logs.some((entry) => entry.event === "webhook_accepted"), false);
  } finally {
    await t.close();
  }
});

test("JSON hỏng trả 400 và body quá lớn trả 413 (không phải 500)", async () => {
  const t = await setup();
  try {
    const broken = await t.post("{không phải json", undefined, true);
    assert.equal(broken.status, 400);
    assert.equal(((await broken.json()) as { code: string }).code, "BAD_REQUEST");

    const huge = await t.post({ ...validEvent, content: "x".repeat(1_100_000) });
    assert.equal(huge.status, 413);
  } finally {
    await t.close();
  }
});

test("gửi lại cùng event không nhân đôi; datasetKey do BE còn gửi thì bị bỏ qua", async () => {
  const t = await setup();
  try {
    await t.post({ ...validEvent, datasetKey: "workspace-7", content: "Bản của GP-1." });
    await t.post({ ...validEvent, id: "GP-2", content: "Bản của GP-2." });
    await t.queue.drain();
    const before = (await t.store.scrollAll()).points.length;

    await t.post({ ...validEvent, content: "Bản của GP-1." });
    await t.queue.drain();

    const { points } = await t.store.scrollAll();
    assert.equal(points.length, before);
    assert.deepEqual(
      points.map((point) => `${point.payload.ideaId}:${point.payload.content}`),
      ["GP-1:Bản của GP-1.", "GP-2:Bản của GP-2."],
    );
    assert.equal(JSON.stringify(points).includes("workspace-7"), false);
  } finally {
    await t.close();
  }
});

test("queue không nhận được job thì trả 503, không bao giờ trả 202", async () => {
  const failingQueue: JobQueue<IndexJob> = {
    publish: async () => {
      throw new Error("broker mất kết nối chứa MARKER-SECRET");
    },
    startConsuming: async () => ({ stop: async () => undefined }),
  };
  const t = await setup({ queue: failingQueue });
  try {
    const response = await t.post(validEvent);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { code: string }).code, "QUEUE_UNAVAILABLE");
    assert.equal(JSON.stringify(t.logs).includes("MARKER-SECRET"), false);
  } finally {
    await t.close();
  }
});

test("chưa cấu hình thì trả 503 WEBHOOK_NOT_CONFIGURED kể cả khi có key", async () => {
  const t = await setup({ unconfigured: true });
  try {
    const response = await t.post(validEvent);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { code: string }).code, "WEBHOOK_NOT_CONFIGURED");
  } finally {
    await t.close();
  }
});

test("fileRef được chấp nhận, mang theo trong job và bỏ qua ở worker (#TODO MinIO); không lộ trong log", async () => {
  const t = await setup();
  try {
    const response = await t.post({ ...validEvent, fileRef: "MARKER-FILEREF/ideas/GP-1.pdf" });
    assert.equal(response.status, 202);
    await t.queue.drain();

    const accepted = t.logs.find((entry) => entry.event === "webhook_accepted");
    assert.equal(accepted?.hasFileRef, true);
    assert.equal(t.logs.find((entry) => entry.event === "index_job_done")?.fileSkipped, true);
    assert.equal(JSON.stringify(t.logs).includes("MARKER-FILEREF"), false);
    // Sáng kiến vẫn được index bằng title + content.
    assert.ok((await t.store.scrollAll()).points.length >= 1);

    assert.equal((await t.post({ ...validEvent, fileRef: 123 })).status, 400);
  } finally {
    await t.close();
  }
});

test("log của luồng webhook và worker không chứa nội dung hay secret", async () => {
  const t = await setup();
  try {
    await t.post(validEvent);
    await t.post({ ...validEvent, title: "" });
    const rawBody = JSON.stringify(validEvent);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const wrongHeaders = signatureHeaders("secret-sai-nhung-du-dai-00000000", rawBody, timestampSeconds);
    await t.postUnsigned(rawBody, wrongHeaders, true);
    await t.queue.drain();

    const serialized = JSON.stringify(t.logs);
    for (const secret of ["MARKER-TITLE", "MARKER-CONTENT", SECRET_1, SECRET_2]) {
      assert.equal(serialized.includes(secret), false, `log lộ ${secret.slice(0, 12)}`);
    }
    assert.ok(t.logs.some((entry) => entry.event === "index_job_done"));
  } finally {
    await t.close();
  }
});

test("loadWebhookHmacSecrets: tách dấu phẩy, yêu cầu có secret và đủ dài", () => {
  assert.deepEqual(
    loadWebhookHmacSecrets({ WEBHOOK_HMAC_SECRETS: ` ${SECRET_1} , ${SECRET_2} ,` }),
    [SECRET_1, SECRET_2],
  );
  for (const env of [
    {},
    { WEBHOOK_HMAC_SECRETS: "" },
    { WEBHOOK_HMAC_SECRETS: " , " },
    { WEBHOOK_HMAC_SECRETS: `${SECRET_1},ngan` },
  ]) {
    assert.throws(() => loadWebhookHmacSecrets(env), WebhookConfigError);
  }
});

// ------------------------------------------------------- body dạng mảng (batch)

const batchEvents = [
  { ...validEvent, id: "GP-A", title: "Tiêu đề A", content: "Nội dung của GP-A." },
  { ...validEvent, id: "GP-B", title: "Tiêu đề B", content: "Nội dung của GP-B." },
  { ...validEvent, id: "GP-C", title: "Tiêu đề C", content: "Nội dung của GP-C." },
];

test("mảng event hợp lệ: 202 kèm danh sách job theo đúng thứ tự, mọi sáng kiến được index", async () => {
  const published: IndexJob[] = [];
  const queue: JobQueue<IndexJob> = {
    publish: async (job) => void published.push(job),
    startConsuming: async () => ({ stop: async () => undefined }),
  };
  const t = await setup({ queue });
  try {
    const response = await t.post(batchEvents);
    const body = (await response.json()) as {
      status: string;
      count: number;
      jobs: Array<{ id: string; jobId: string }>;
    };

    assert.equal(response.status, 202);
    assert.equal(body.status, "accepted");
    assert.equal(body.count, 3);
    assert.deepEqual(body.jobs.map((job) => job.id), ["GP-A", "GP-B", "GP-C"]);
    assert.equal(new Set(body.jobs.map((job) => job.jobId)).size, 3);
    assert.deepEqual(body.jobs.map((job) => job.jobId), published.map((job) => job.jobId));
    assert.deepEqual(published.map((job) => job.ideaId), ["GP-A", "GP-B", "GP-C"]);
    assert.equal(t.logs.filter((entry) => entry.event === "webhook_accepted").length, 3);
  } finally {
    await t.close();
  }

  // Cùng mảng đó qua hàng đợi thật (worker trong bộ nhớ): cả ba vào store.
  const real = await setup();
  try {
    assert.equal((await real.post(batchEvents)).status, 202);
    await real.queue.drain();
    const ids = new Set((await real.store.scrollAll()).points.map((p) => p.payload.ideaId));
    assert.deepEqual([...ids].sort(), ["GP-A", "GP-B", "GP-C"]);
  } finally {
    await real.close();
  }
});

test("mảng một phần tử vẫn trả dạng danh sách; object đơn giữ nguyên dạng cũ { status, jobId }", async () => {
  const t = await setup();
  try {
    const single = (await (await t.post(validEvent)).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(single).sort(), ["jobId", "status"]);

    const one = (await (await t.post([{ ...validEvent, id: "GP-ONE" }])).json()) as {
      count: number;
      jobs: unknown[];
    } & Record<string, unknown>;
    assert.equal(one.count, 1);
    assert.equal(one.jobs.length, 1);
    assert.equal("jobId" in one, false);
  } finally {
    await t.close();
  }
});

test("mảng có một phần tử sai: 400 nêu chỉ số, không enqueue phần tử nào và không giữ chỗ replay", async () => {
  const published: IndexJob[] = [];
  const queue: JobQueue<IndexJob> = {
    publish: async (job) => void published.push(job),
    startConsuming: async () => ({ stop: async () => undefined }),
  };
  const claims: string[] = [];
  const spyGuard: ReplayGuard = {
    claim: async (key) => {
      claims.push(key);
      return true;
    },
    release: async () => undefined,
  };
  const t = await setup({ queue, replayGuard: spyGuard });
  try {
    const cases: Array<[unknown[], string]> = [
      [[batchEvents[0], { ...batchEvents[1], title: "GIA-TRI-NHAY-CAM", content: "" }], "[1]"],
      [[batchEvents[0], "không phải object"], "[1]"],
      [[batchEvents[0], null], "[1]"],
      [[batchEvents[0], [batchEvents[1]]], "[1]"],
      [[{ ...batchEvents[0], fileRef: 123 }, batchEvents[1]], "[0]"],
    ];
    for (const [body, indexLabel] of cases) {
      const response = await t.post(body);
      assert.equal(response.status, 400);
      const error = (await response.json()) as { code: string; message: string };
      assert.equal(error.code, "INVALID_EVENT");
      assert.ok(error.message.includes(indexLabel), `thiếu ${indexLabel} trong: ${error.message}`);
      assert.equal(error.message.includes("GIA-TRI-NHAY-CAM"), false);
    }
    assert.equal(published.length, 0);
    assert.deepEqual(claims, []);
  } finally {
    await t.close();
  }
});

test("mảng rỗng hoặc vượt MAX_BATCH_SIZE bị từ chối; đúng MAX_BATCH_SIZE được nhận", async () => {
  const t = await setup();
  try {
    const make = (count: number) =>
      Array.from({ length: count }, (_value, index) => ({ ...validEvent, id: `GP-N${index}` }));

    const empty = await t.post([]);
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as { code: string }).code, "INVALID_EVENT");

    const tooMany = await t.post(make(MAX_BATCH_SIZE + 1));
    assert.equal(tooMany.status, 400);
    assert.equal(((await tooMany.json()) as { code: string }).code, "INVALID_EVENT");

    const atLimit = await t.post(make(MAX_BATCH_SIZE));
    assert.equal(atLimit.status, 202);
    assert.equal(((await atLimit.json()) as { count: number }).count, MAX_BATCH_SIZE);
  } finally {
    await t.close();
  }
});

test("mảng: một chữ ký cho cả request, gửi lại nguyên mảng thì 409 và không enqueue lại", async () => {
  const published: IndexJob[] = [];
  const queue: JobQueue<IndexJob> = {
    publish: async (job) => void published.push(job),
    startConsuming: async () => ({ stop: async () => undefined }),
  };
  const claims: string[] = [];
  const guard = new InMemoryReplayGuard();
  const spyGuard: ReplayGuard = {
    claim: async (key, ttl) => {
      claims.push(key);
      return guard.claim(key, ttl);
    },
    release: (key) => guard.release(key),
  };
  const t = await setup({ queue, replayGuard: spyGuard });
  try {
    const raw = JSON.stringify(batchEvents);
    const headers = signatureHeaders(SECRET_1, raw, Math.floor(Date.now() / 1000));

    assert.equal((await t.postUnsigned(raw, headers, true)).status, 202);
    assert.equal(claims.length, 1); // một lần giữ chỗ cho cả 3 phần tử
    assert.equal(published.length, 3);

    const replay = await t.postUnsigned(raw, headers, true);
    assert.equal(replay.status, 409);
    assert.equal(((await replay.json()) as { code: string }).code, "DUPLICATE_DELIVERY");
    assert.equal(published.length, 3);
  } finally {
    await t.close();
  }
});

test("mảng: chữ ký sai vẫn 401 trước khi đụng tới nội dung mảng", async () => {
  const t = await setup();
  try {
    const raw = JSON.stringify(batchEvents);
    const wrong = signatureHeaders(
      "secret-sai-nhung-du-dai-00000000",
      raw,
      Math.floor(Date.now() / 1000),
    );
    assert.equal((await t.postUnsigned(raw, wrong, true)).status, 401);
    assert.equal((await t.postUnsigned(raw, {}, true)).status, 401);
    await t.queue.drain();
    assert.equal((await t.store.scrollAll()).points.length, 0);
  } finally {
    await t.close();
  }
});

test("mảng: cùng `id` hai lần thì phần tử sau ghi đè phần tử trước (giữ thứ tự mảng)", async () => {
  const t = await setup();
  try {
    const response = await t.post([
      { ...validEvent, id: "GP-DUP", content: "Bản cũ." },
      { ...validEvent, id: "GP-OTHER", content: "Sáng kiến khác." },
      { ...validEvent, id: "GP-DUP", content: "Bản mới." },
    ]);
    assert.equal(response.status, 202);
    await t.queue.drain();

    const contents = new Map(
      (await t.store.scrollAll()).points.map((point) => [point.payload.ideaId, point.payload.content]),
    );
    assert.equal(contents.get("GP-DUP"), "Bản mới.");
    assert.equal(contents.get("GP-OTHER"), "Sáng kiến khác.");
  } finally {
    await t.close();
  }
});

test("mảng: đồng hồ ghi job chỉ đọc một lần, mọi job cùng receivedAt", async () => {
  const published: IndexJob[] = [];
  const queue: JobQueue<IndexJob> = {
    publish: async (job) => void published.push(job),
    startConsuming: async () => ({ stop: async () => undefined }),
  };
  const fixed = new Date("2020-01-01T00:00:00Z");
  let nowCalls = 0;
  const t = await setup({
    queue,
    now: () => {
      nowCalls += 1;
      return fixed;
    },
  });
  try {
    assert.equal((await t.post(batchEvents)).status, 202);
    assert.equal(nowCalls, 1);
    assert.deepEqual(
      published.map((job) => job.receivedAt),
      batchEvents.map(() => fixed.toISOString()),
    );
  } finally {
    await t.close();
  }
});

test("mảng: enqueue lỗi giữa chừng thì 503, trả chỗ replay; gửi lại cả mảng được nhận đủ", async () => {
  const published: IndexJob[] = [];
  let calls = 0;
  const flakyQueue: JobQueue<IndexJob> = {
    publish: async (job) => {
      calls += 1;
      if (calls === 2) throw new Error("broker mất kết nối chứa MARKER-SECRET");
      published.push(job);
    },
    startConsuming: async () => ({ stop: async () => undefined }),
  };
  const t = await setup({ queue: flakyQueue });
  try {
    const raw = JSON.stringify(batchEvents);
    const headers = signatureHeaders(SECRET_1, raw, Math.floor(Date.now() / 1000));

    const failed = await t.postUnsigned(raw, headers, true);
    assert.equal(failed.status, 503);
    assert.equal(((await failed.json()) as { code: string }).code, "QUEUE_UNAVAILABLE");
    assert.deepEqual(published.map((job) => job.ideaId), ["GP-A"]); // chỉ phần tử đầu vào được
    assert.equal(t.logs.some((entry) => entry.event === "webhook_accepted"), false);
    const failure = t.logs.find((entry) => entry.event === "webhook_enqueue_failed");
    assert.equal(failure?.ideaId, "GP-B");
    assert.equal(failure?.enqueued, 1);
    assert.equal(failure?.batchSize, 3);
    assert.equal(JSON.stringify(t.logs).includes("MARKER-SECRET"), false);

    // Chỗ replay đã được trả: gửi lại đúng request đó được nhận, rồi mới bị chặn.
    assert.equal((await t.postUnsigned(raw, headers, true)).status, 202);
    assert.deepEqual(
      published.map((job) => job.ideaId),
      ["GP-A", "GP-A", "GP-B", "GP-C"], // GP-A vào hai lần: chấp nhận được vì index idempotent
    );
    assert.equal((await t.postUnsigned(raw, headers, true)).status, 409);
  } finally {
    await t.close();
  }
});

// ------------------------------------------------- 1. khớp route như Express

test("route khớp không phân biệt hoa/thường, dấu / cuối và query, vẫn xác minh trên raw body", async () => {
  const t = await setup();
  try {
    const paths = [
      "/webhooks/idea-approved/",
      "/Webhooks/Idea-Approved",
      "/webhooks/idea-approved?source=be",
    ];
    for (const [index, path] of paths.entries()) {
      const response = await t.post({ ...validEvent, id: `GP-PATH-${index}` }, {}, false, path);
      assert.equal(response.status, 202, `path ${path}`);
    }
    await t.queue.drain();
    assert.equal(rejectedReasons(t.logs).length, 0);
    assert.equal(new Set((await t.store.scrollAll()).points.map((p) => p.payload.ideaId)).size, 3);
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------- 2. chống replay

test("replay: cùng request đã ký chỉ nhận một lần, bản cũ gửi lại không ghi đè bản mới", async () => {
  const t = await setup();
  try {
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const v1 = JSON.stringify({ ...validEvent, content: "Bản v1." });
    const v2 = JSON.stringify({ ...validEvent, content: "Bản v2." });
    const headersV1 = signatureHeaders(SECRET_1, v1, timestampSeconds);
    const headersV2 = signatureHeaders(SECRET_1, v2, timestampSeconds);

    assert.equal((await t.postUnsigned(v1, headersV1, true)).status, 202);
    assert.equal((await t.postUnsigned(v2, headersV2, true)).status, 202);
    await t.queue.drain();

    // Kẻ chặn được v1 trong log/proxy gửi lại sau khi v2 đã được index.
    const replay = await t.postUnsigned(v1, headersV1, true);
    assert.equal(replay.status, 409);
    assert.equal(((await replay.json()) as { code: string }).code, "DUPLICATE_DELIVERY");
    await t.queue.drain();

    assert.deepEqual(
      (await t.store.scrollAll()).points.map((point) => point.payload.content),
      ["Bản v2."],
    );
    assert.deepEqual(rejectedReasons(t.logs), ["replayed_signature"]);
    assert.equal(t.logs.filter((entry) => entry.event === "webhook_accepted").length, 2);
  } finally {
    await t.close();
  }
});

test("replay: hai request giống hệt gửi đồng thời chỉ một request được nhận", async () => {
  const t = await setup();
  try {
    const raw = JSON.stringify(validEvent);
    const headers = signatureHeaders(SECRET_1, raw, Math.floor(Date.now() / 1000));
    const statuses = (
      await Promise.all([1, 2, 3].map(() => t.postUnsigned(raw, headers, true)))
    )
      .map((response) => response.status)
      .sort();
    assert.deepEqual(statuses, [202, 409, 409]);
  } finally {
    await t.close();
  }
});

test("replay: enqueue lỗi thì trả chỗ, gửi lại đúng request đó được nhận rồi mới bị chặn", async () => {
  let publishCalls = 0;
  const flakyQueue: JobQueue<IndexJob> = {
    publish: async () => {
      publishCalls += 1;
      if (publishCalls === 1) throw new Error("broker mất kết nối");
    },
    startConsuming: async () => ({ stop: async () => undefined }),
  };
  const t = await setup({ queue: flakyQueue });
  try {
    const raw = JSON.stringify(validEvent);
    const headers = signatureHeaders(SECRET_1, raw, Math.floor(Date.now() / 1000));

    assert.equal((await t.postUnsigned(raw, headers, true)).status, 503);
    assert.equal((await t.postUnsigned(raw, headers, true)).status, 202);
    assert.equal((await t.postUnsigned(raw, headers, true)).status, 409);
    assert.equal(publishCalls, 2);
  } finally {
    await t.close();
  }
});

test("replay: guard lỗi thì fail closed (503), không enqueue và không lộ chi tiết lỗi", async () => {
  const published: IndexJob[] = [];
  const queue: JobQueue<IndexJob> = {
    publish: async (job) => void published.push(job),
    startConsuming: async () => ({ stop: async () => undefined }),
  };
  const brokenGuard: ReplayGuard = {
    claim: async () => {
      throw new Error("redis://:MARKER-SECRET@host đã sập");
    },
    release: async () => undefined,
  };
  const t = await setup({ queue, replayGuard: brokenGuard });
  try {
    const response = await t.post(validEvent);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { code: string }).code, "QUEUE_UNAVAILABLE");
    assert.equal(published.length, 0);
    assert.ok(t.logs.some((entry) => entry.event === "webhook_replay_guard_failed"));
    assert.equal(JSON.stringify(t.logs).includes("MARKER-SECRET"), false);
  } finally {
    await t.close();
  }
});

test("replay: request sai định dạng (400) không giữ chỗ", async () => {
  const claims: string[] = [];
  const spyGuard: ReplayGuard = {
    claim: async (key) => {
      claims.push(key);
      return true;
    },
    release: async () => undefined,
  };
  const t = await setup({ replayGuard: spyGuard });
  try {
    assert.equal((await t.post({ ...validEvent, title: "" })).status, 400);
    assert.equal((await t.post("{không phải json", undefined, true)).status, 400);
    assert.deepEqual(claims, []);
    assert.equal((await t.post(validEvent)).status, 202);
    assert.equal(claims.length, 1);
    assert.match(claims[0]!, /^[0-9a-f]{64}$/);
  } finally {
    await t.close();
  }
});

test("InMemoryReplayGuard: giữ chỗ tới hết TTL, release trả chỗ, dọn khoá hết hạn", async () => {
  let nowMs = 1_000_000;
  const guard = new InMemoryReplayGuard(() => nowMs);

  assert.equal(await guard.claim("a", 10), true);
  assert.equal(await guard.claim("a", 10), false);
  assert.equal(await guard.claim("b", 10), true);

  nowMs += 9_999;
  assert.equal(await guard.claim("a", 10), false);
  nowMs += 1;
  assert.equal(await guard.claim("a", 10), true);

  await guard.release("a");
  assert.equal(await guard.claim("a", 10), true);
});

function fakeRedis(initialStatus = "ready") {
  const calls: unknown[][] = [];
  const keys = new Set<string>();
  let quits = 0;
  let disconnects = 0;
  const client: ReplayRedisClient = {
    status: initialStatus,
    set: async (key, value, expireToken, seconds, nx) => {
      calls.push(["set", key, value, expireToken, seconds, nx]);
      if (keys.has(key)) return null;
      keys.add(key);
      return "OK";
    },
    del: async (key) => {
      calls.push(["del", key]);
      return keys.delete(key) ? 1 : 0;
    },
    quit: async () => void quits++,
    disconnect: () => void disconnects++,
  };
  return { client, calls, counts: () => ({ quits, disconnects }) };
}

test("RedisReplayGuard: SET key EX ttl NX có tiền tố, release xoá đúng khoá", async () => {
  const redis = fakeRedis();
  const guard = new RedisReplayGuard(redis.client, "p:webhook-replay:");

  assert.equal(await guard.claim("abc", 601), true);
  assert.equal(await guard.claim("abc", 601), false);
  await guard.release("abc");
  assert.equal(await guard.claim("abc", 601), true);

  assert.deepEqual(redis.calls[0], ["set", "p:webhook-replay:abc", "1", "EX", 601, "NX"]);
  assert.deepEqual(redis.calls[2], ["del", "p:webhook-replay:abc"]);
});

test("RedisReplayGuard.close: kết nối ready thì quit rồi disconnect, chưa ready thì chỉ disconnect", async () => {
  const ready = fakeRedis("ready");
  await new RedisReplayGuard(ready.client, "p:").close();
  assert.deepEqual(ready.counts(), { quits: 1, disconnects: 1 });

  const connecting = fakeRedis("connecting");
  await new RedisReplayGuard(connecting.client, "p:").close();
  assert.deepEqual(connecting.counts(), { quits: 0, disconnects: 1 });
});

test("cửa sổ nhớ chữ ký phủ trọn khoảng thời gian chữ ký còn hiệu lực", () => {
  // Chữ ký nhận được từ (timestamp - dung sai) đến (timestamp + dung sai).
  assert.ok(REPLAY_WINDOW_SECONDS >= HMAC_TIMESTAMP_TOLERANCE_SECONDS * 2);
});

// ------------------------------- 3. xác thực trước khi parse JSON, 4. content-type

test("body hỏng mà thiếu/sai chữ ký trả 401 (không parse JSON trước khi xác thực)", async () => {
  const t = await setup();
  try {
    const broken = "{không phải json";
    const timestampSeconds = Math.floor(Date.now() / 1000);

    const unsigned = await t.postUnsigned(broken, {}, true);
    const wrongSecret = await t.postUnsigned(
      broken,
      signatureHeaders("secret-sai-nhung-du-dai-00000000", broken, timestampSeconds),
      true,
    );
    // Quá giới hạn kích thước nhưng không có chữ ký: bị từ chối trước khi đọc body.
    const hugeUnsigned = await t.postUnsigned({ content: "x".repeat(1_100_000) }, {});

    assert.equal(unsigned.status, 401);
    assert.equal(wrongSecret.status, 401);
    assert.equal(hugeUnsigned.status, 401);
    assert.deepEqual(rejectedReasons(t.logs), [
      "missing_signature",
      "invalid_signature",
      "missing_signature",
    ]);
  } finally {
    await t.close();
  }
});

test("body rỗng đã ký trả 400, không phải 401/500", async () => {
  const t = await setup();
  try {
    const response = await t.post("", undefined, true);
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code: string }).code, "BAD_REQUEST");
  } finally {
    await t.close();
  }
});

test("content-type không phải JSON: đã ký đúng thì 415 nêu rõ nguyên nhân, ký sai vẫn 401", async () => {
  const t = await setup();
  try {
    const raw = JSON.stringify(validEvent);
    const timestampSeconds = Math.floor(Date.now() / 1000);

    const plain = await t.post(raw, { "content-type": "text/plain" }, true);
    assert.equal(plain.status, 415);
    assert.equal(((await plain.json()) as { code: string }).code, "UNSUPPORTED_MEDIA_TYPE");

    const plainWrongSecret = await t.postUnsigned(
      raw,
      {
        "content-type": "text/plain",
        ...signatureHeaders("secret-sai-nhung-du-dai-00000000", raw, timestampSeconds),
      },
      true,
    );
    assert.equal(plainWrongSecret.status, 401);

    const withCharset = await t.post(
      { ...validEvent, id: "GP-CHARSET" },
      { "content-type": "application/json; charset=utf-8" },
    );
    assert.equal(withCharset.status, 202);

    assert.deepEqual(rejectedReasons(t.logs), ["unsupported_media_type", "invalid_signature"]);
    await t.queue.drain();
    assert.deepEqual(
      (await t.store.scrollAll()).points.map((p) => p.payload.ideaId),
      ["GP-CHARSET"],
    );
  } finally {
    await t.close();
  }
});

// ------------------------------------------------- 7. định dạng chữ ký/timestamp

test("timestamp chỉ nhận số nguyên epoch giây dạng chuẩn dù chữ ký phủ đúng chuỗi đó", async () => {
  const t = await setup();
  try {
    const raw = JSON.stringify(validEvent);
    const seconds = Math.floor(Date.now() / 1000);
    const nonCanonical = [
      `0${seconds}`, // số 0 đầu dòng
      `${seconds}.5`, // phần thập phân
      `${seconds}e0`, // dạng mũ
      `0x${seconds.toString(16)}`, // hex
      `+${seconds}`, // dấu cộng
      `-${seconds}`, // số âm
    ];
    for (const timestamp of nonCanonical) {
      const response = await t.postUnsigned(raw, signatureHeaders(SECRET_1, raw, timestamp), true);
      assert.equal(response.status, 401, `timestamp ${timestamp}`);
    }
    assert.deepEqual(rejectedReasons(t.logs), nonCanonical.map(() => "invalid_timestamp"));

    assert.equal(
      (await t.postUnsigned(raw, signatureHeaders(SECRET_1, raw, String(seconds)), true)).status,
      202,
    );
  } finally {
    await t.close();
  }
});

test("thiếu timestamp, chữ ký sai độ dài/không phải hex đều bị từ chối; hex trần không cần tiền tố sha256=", async () => {
  const t = await setup();
  try {
    const raw = JSON.stringify(validEvent);
    const seconds = Math.floor(Date.now() / 1000);
    const valid = signatureHeaders(SECRET_1, raw, seconds);
    const hex = valid["x-webhook-signature"]!.replace("sha256=", "");

    const cases: Array<[string, Record<string, string>]> = [
      ["missing_timestamp", { "x-webhook-signature": valid["x-webhook-signature"]! }],
      ["invalid_signature", { ...valid, "x-webhook-signature": "sha256=abc" }],
      ["invalid_signature", { ...valid, "x-webhook-signature": `sha256=${hex.slice(1)}` }],
      ["invalid_signature", { ...valid, "x-webhook-signature": `sha256=${hex}00` }],
      ["invalid_signature", { ...valid, "x-webhook-signature": `sha256=${"zz".repeat(32)}` }],
    ];
    for (const [, headers] of cases) {
      assert.equal((await t.postUnsigned(raw, headers, true)).status, 401);
    }
    assert.deepEqual(rejectedReasons(t.logs), cases.map(([reason]) => reason));

    const bare = await t.postUnsigned(raw, { ...valid, "x-webhook-signature": hex }, true);
    assert.equal(bare.status, 202);
  } finally {
    await t.close();
  }
});

test("biên dung sai timestamp: ±300 giây nhận, ±301 giây từ chối (cả quá khứ lẫn tương lai)", async () => {
  const fixedNow = new Date("2026-11-04T01:00:00Z");
  const base = fixedNow.getTime() / 1000;
  const t = await setup({ authNow: () => fixedNow });
  try {
    const raw = JSON.stringify(validEvent);
    const cases: Array<[number, number]> = [
      [0, 202],
      [-HMAC_TIMESTAMP_TOLERANCE_SECONDS, 202],
      [HMAC_TIMESTAMP_TOLERANCE_SECONDS, 202],
      [-HMAC_TIMESTAMP_TOLERANCE_SECONDS - 1, 401],
      [HMAC_TIMESTAMP_TOLERANCE_SECONDS + 1, 401],
    ];
    for (const [offset, expected] of cases) {
      const headers = signatureHeaders(SECRET_1, raw, base + offset);
      const response = await t.postUnsigned(raw, headers, true);
      assert.equal(response.status, expected, `lệch ${offset}s`);
    }
    assert.deepEqual(rejectedReasons(t.logs), ["stale_timestamp", "stale_timestamp"]);
  } finally {
    await t.close();
  }
});

// ------------------------------------ 8. đồng hồ xác thực tách khỏi đồng hồ ghi job

test("đồng hồ ghi job (now) không ảnh hưởng xác thực và chỉ được đọc một lần mỗi request", async () => {
  const published: IndexJob[] = [];
  const queue: JobQueue<IndexJob> = {
    publish: async (job) => void published.push(job),
    startConsuming: async () => ({ stop: async () => undefined }),
  };
  // Đồng hồ cố định xa giờ thật: nếu nó bị dùng để kiểm tra chữ ký thì mọi
  // request ký bằng giờ thật sẽ bị từ chối stale_timestamp.
  const fixed = new Date("2020-01-01T00:00:00Z");
  let nowCalls = 0;
  const t = await setup({
    queue,
    now: () => {
      nowCalls += 1;
      return fixed;
    },
  });
  try {
    const response = await t.post(validEvent);
    assert.equal(response.status, 202);
    assert.equal(nowCalls, 1);
    assert.equal(published[0]?.receivedAt, fixed.toISOString());
  } finally {
    await t.close();
  }
});

// ------------------------------------------------ 6. đổi tên biến cấu hình

test("loadWebhookHmacSecrets: thiếu secret mà còn WEBHOOK_API_KEYS thì báo rõ biến cũ đã bị thay", () => {
  assert.throws(
    () => loadWebhookHmacSecrets({ WEBHOOK_API_KEYS: "khoa-cu-du-dai-0000000" }),
    (error: unknown) =>
      error instanceof WebhookConfigError &&
      /WEBHOOK_API_KEYS/.test(error.message) &&
      /WEBHOOK_HMAC_SECRETS/.test(error.message) &&
      !error.message.includes("khoa-cu-du-dai-0000000"),
  );
  assert.throws(
    () => loadWebhookHmacSecrets({}),
    (error: unknown) => error instanceof WebhookConfigError && !/WEBHOOK_API_KEYS/.test(error.message),
  );
});

// ------------------------------------------------- type quyết định collection

/** Hàng đợi ghi lại job thay vì xử lý, để chứng minh job có (hay không) được đẩy vào. */
function recordingQueue() {
  const published: IndexJob[] = [];
  const queue: JobQueue<IndexJob> = {
    publish: async (job) => void published.push(job),
    startConsuming: async () => ({ stop: async () => undefined }),
  };
  return { published, queue };
}

test("type không hợp lệ: 400 INVALID_EVENT nêu tên trường, không enqueue, không giữ chỗ replay, không lặp lại giá trị gửi", async () => {
  const { published, queue } = recordingQueue();
  const claims: string[] = [];
  const spyGuard: ReplayGuard = {
    claim: async (key) => {
      claims.push(key);
      return true;
    },
    release: async () => undefined,
  };
  const t = await setup({ queue, replayGuard: spyGuard });
  try {
    // Gồm các giá trị của mô hình cũ ("solution", "initiative", "idea", "project", "other").
    const bogusTypes: unknown[] = [
      "solution", "initiative", "idea", "project", "other", "Ideas", "SOLUTIONS", " ideas", "ideas ",
      "GIA-TRI-NHAY-CAM", "", "   ", 123, null, ["ideas"], { type: "ideas" }, undefined,
    ];
    for (const type of bogusTypes) {
      const response = await t.post({ ...validEvent, type });
      assert.equal(response.status, 400, `type ${JSON.stringify(type)}`);
      const error = (await response.json()) as { code: string; message: string };
      assert.equal(error.code, "INVALID_EVENT");
      assert.ok(error.message.includes("type"), error.message);
      assert.ok(error.message.includes("ideas, solutions, initiatives"), error.message);
      assert.equal(error.message.includes("GIA-TRI-NHAY-CAM"), false);
    }
    // Thiếu hẳn trường type.
    const { type: _omitted, ...withoutType } = validEvent;
    assert.equal((await t.post(withoutType)).status, 400);

    assert.equal(published.length, 0);
    assert.deepEqual(claims, []);
  } finally {
    await t.close();
  }
});

test("mảng có một phần tử sai type: cả mảng bị từ chối với chỉ số phần tử, không phần tử nào được enqueue", async () => {
  const { published, queue } = recordingQueue();
  const t = await setup({ queue });
  try {
    const response = await t.post([
      { ...validEvent, id: "GP-A", type: "ideas" },
      { ...validEvent, id: "GP-B", type: "solution" },
      { ...validEvent, id: "GP-C", type: "initiatives" },
    ]);

    assert.equal(response.status, 400);
    const error = (await response.json()) as { code: string; message: string };
    assert.equal(error.code, "INVALID_EVENT");
    assert.ok(error.message.includes("[1]") && error.message.includes("type"), error.message);
    assert.equal(published.length, 0, "phần tử hợp lệ đứng trước cũng không được nhận");
  } finally {
    await t.close();
  }
});

test("mỗi type hợp lệ được nhận (202) và job mang đúng type", async () => {
  const { published, queue } = recordingQueue();
  const t = await setup({ queue });
  try {
    for (const type of RECORD_TYPES) {
      assert.equal((await t.post({ ...validEvent, id: `GP-${type}`, type })).status, 202);
    }
    assert.deepEqual(
      published.map((job) => [job.ideaId, job.type]),
      RECORD_TYPES.map((type) => [`GP-${type}`, type]),
    );
  } finally {
    await t.close();
  }
});

test("qua hàng đợi thật: mỗi sáng kiến vào đúng collection của type, hai collection còn lại không nhận gì", async () => {
  const t = await setup();
  try {
    // Mảng gồm cả ba type, kể cả hai phần tử khác type dùng chung `id`.
    const response = await t.post([
      { ...validEvent, id: "I-1", type: "ideas", content: "Nội dung ideas." },
      { ...validEvent, id: "S-1", type: "solutions", content: "Nội dung solutions." },
      { ...validEvent, id: "N-1", type: "initiatives", content: "Nội dung initiatives." },
      { ...validEvent, id: "DUNG-CHUNG", type: "ideas", content: "Bản ideas." },
      { ...validEvent, id: "DUNG-CHUNG", type: "initiatives", content: "Bản initiatives." },
    ]);
    assert.equal(response.status, 202);
    await t.queue.drain();

    const contents = async (type: (typeof RECORD_TYPES)[number]) =>
      (await t.stores.forType(type).scrollAll()).points
        .map((point) => [point.payload.ideaId, point.payload.type, point.payload.content])
        .sort();
    assert.deepEqual(await contents("ideas"), [
      ["DUNG-CHUNG", "ideas", "Bản ideas."],
      ["I-1", "ideas", "Nội dung ideas."],
    ]);
    assert.deepEqual(await contents("solutions"), [["S-1", "solutions", "Nội dung solutions."]]);
    assert.deepEqual(await contents("initiatives"), [
      ["DUNG-CHUNG", "initiatives", "Bản initiatives."],
      ["N-1", "initiatives", "Nội dung initiatives."],
    ]);
  } finally {
    await t.close();
  }
});

test("job type cũ (\"solution\") còn trong hàng đợi từ trước khi tách collection: worker đưa vào hàng chờ lỗi, không retry, không ghi gì", async () => {
  const t = await setup();
  try {
    // Chèn thẳng vào hàng đợi, bỏ qua webhook, như một job tồn từ phiên bản trước.
    await t.queue.publish({
      jobId: "job-cu",
      ideaId: "GP-CU",
      type: "solution" as never,
      title: "Job cũ",
      content: "Nội dung job cũ.",
      metadata: {},
      receivedAt: "2026-11-04T00:00:00.000Z",
    });
    await t.queue.drain();

    assert.deepEqual(
      t.queue.deadLetters.map((entry) => [entry.job.jobId, entry.reason, entry.attempt]),
      [["job-cu", "non_retryable:INVALID_TYPE", 1]],
    );
    for (const type of RECORD_TYPES) {
      assert.equal((await t.stores.forType(type).scrollAll()).points.length, 0);
    }
  } finally {
    await t.close();
  }
});
