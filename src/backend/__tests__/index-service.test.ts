import { test } from "node:test";
import assert from "node:assert/strict";
import { startIndexWorker, startWebhookService } from "../index-service.js";
import { InMemoryReplayGuard, RedisReplayGuard } from "../replay-guard.js";

const mockEnv = {
  WEBHOOK_HMAC_SECRETS: "webhook-secret-number-one-0001",
  EMBEDDING_MOCK_MODE: "true",
  QDRANT_MOCK_MODE: "true",
  QUEUE_MOCK_MODE: "true",
};

// Một Redis không tồn tại: đủ để kiểm khởi động/tắt mà không cần Redis thật.
const unreachableRedis = {
  QUEUE_MOCK_MODE: undefined,
  REDIS_URL: "redis://nguoi:mat-khau-bi-mat-123@127.0.0.1:1",
} as NodeJS.ProcessEnv;

function captureLogs() {
  const logs: Array<Record<string, unknown>> = [];
  return {
    logs,
    log: (level: string, event: string, details: Record<string, unknown>) => {
      logs.push({ level, event, ...details });
    },
  };
}

test("web, chế độ mock: có webhook deps, worker chạy cùng tiến trình và dừng được", async () => {
  const { logs, log } = captureLogs();
  const service = await startWebhookService(mockEnv, log as never);

  assert.ok(service);
  assert.deepEqual(service.webhook.hmacSecrets, ["webhook-secret-number-one-0001"]);
  assert.equal(logs[0]!.event, "webhook_service_started");
  assert.equal(logs[0]!.queue, "in-memory");
  assert.equal(logs[0]!.worker, "inline");
  await service.stop();
});

test("web, thiếu cấu hình: trả null và ghi log, không ném lỗi làm sập app", async () => {
  for (const [name, env] of [
    ["thiếu HMAC secret", { ...mockEnv, WEBHOOK_HMAC_SECRETS: "" }],
    // Chế độ mock chạy worker cùng tiến trình nên vẫn cần cấu hình embedding/Qdrant.
    ["mock queue thiếu Gemini key", { ...mockEnv, EMBEDDING_MOCK_MODE: undefined }],
    ["mock queue thiếu Qdrant", { ...mockEnv, QDRANT_MOCK_MODE: undefined }],
  ] as const) {
    const { logs, log } = captureLogs();
    const service = await startWebhookService(env as NodeJS.ProcessEnv, log as never);

    assert.equal(service, null, name);
    assert.equal(logs[0]!.event, "index_service_disabled", name);
    assert.equal(logs[0]!.errorCode, "NOT_CONFIGURED", name);
  }
});

test("web, không đặt QUEUE_MOCK_MODE và thiếu REDIS_URL: service tắt với thông báo rõ", async () => {
  const { logs, log } = captureLogs();
  const service = await startWebhookService({ ...mockEnv, QUEUE_MOCK_MODE: undefined } as NodeJS.ProcessEnv, log as never);

  assert.equal(service, null);
  assert.equal(logs[0]!.errorCode, "NOT_CONFIGURED");
  assert.match(String(logs[0]!.message), /REDIS_URL/);
});

test("web dùng BullMQ chỉ cần REDIS_URL và HMAC secret, không cần khoá Gemini/Qdrant; không chạy worker", async () => {
  const { logs, log } = captureLogs();
  const startedAt = Date.now();
  const service = await startWebhookService(
    { WEBHOOK_HMAC_SECRETS: mockEnv.WEBHOOK_HMAC_SECRETS, ...unreachableRedis },
    log as never,
  );

  assert.ok(service);
  assert.ok(Date.now() - startedAt < 2000, "khởi động không được chờ Redis");
  const started = logs.find((entry) => entry.event === "webhook_service_started");
  assert.equal(started?.queue, "bullmq");
  assert.equal(started?.worker, "external");
  await service.stop();
  assert.equal(JSON.stringify(logs).includes("mat-khau-bi-mat"), false);
});

test("web: guard replay dùng bộ nhớ ở chế độ mock và Redis (đóng được khi tắt) ở chế độ BullMQ", async () => {
  const mock = await startWebhookService(mockEnv, captureLogs().log as never);
  assert.ok(mock);
  assert.ok(mock.webhook.replayGuard instanceof InMemoryReplayGuard);
  await mock.stop();

  const startedAt = Date.now();
  const bull = await startWebhookService(
    { WEBHOOK_HMAC_SECRETS: mockEnv.WEBHOOK_HMAC_SECRETS, ...unreachableRedis },
    captureLogs().log as never,
  );
  assert.ok(bull);
  assert.ok(bull.webhook.replayGuard instanceof RedisReplayGuard);
  await bull.stop(); // Redis không với tới được: tắt không được treo
  assert.ok(Date.now() - startedAt < 5000, "stop() phải xong nhanh dù Redis không kết nối được");
});

test("web: còn WEBHOOK_API_KEYS cũ thì ghi cảnh báo và chỉ nhận HMAC; thiếu HMAC thì thông báo nêu biến đã đổi tên", async () => {
  const legacyKey = "khoa-cu-du-dai-0000000";

  const both = captureLogs();
  const service = await startWebhookService(
    { ...mockEnv, WEBHOOK_API_KEYS: legacyKey },
    both.log as never,
  );
  assert.ok(service);
  assert.ok(both.logs.some((entry) => entry.event === "webhook_legacy_api_keys_ignored"));
  assert.equal(JSON.stringify(both.logs).includes(legacyKey), false);
  await service.stop();

  const onlyLegacy = captureLogs();
  const disabled = await startWebhookService(
    { ...mockEnv, WEBHOOK_HMAC_SECRETS: undefined, WEBHOOK_API_KEYS: legacyKey } as NodeJS.ProcessEnv,
    onlyLegacy.log as never,
  );
  assert.equal(disabled, null);
  const entry = onlyLegacy.logs.find((item) => item.event === "index_service_disabled");
  assert.match(String(entry?.message), /WEBHOOK_API_KEYS.*WEBHOOK_HMAC_SECRETS/);
  assert.equal(JSON.stringify(onlyLegacy.logs).includes(legacyKey), false);

  const none = captureLogs();
  await startWebhookService({ ...mockEnv, WEBHOOK_API_KEYS: undefined } as NodeJS.ProcessEnv, none.log as never).then((s) => s?.stop());
  assert.equal(none.logs.some((item) => item.event === "webhook_legacy_api_keys_ignored"), false);
});

test("log khởi động của web không chứa HMAC secret", async () => {
  const { logs, log } = captureLogs();
  const service = await startWebhookService(mockEnv, log as never);

  assert.equal(JSON.stringify(logs).includes(mockEnv.WEBHOOK_HMAC_SECRETS), false);
  await service?.stop();
});

test("worker: từ chối QUEUE_MOCK_MODE vì hàng đợi trong bộ nhớ không chia sẻ được giữa hai tiến trình", async () => {
  await assert.rejects(
    () => startIndexWorker(mockEnv, captureLogs().log as never),
    (error: unknown) =>
      (error as { code?: string }).code === "NOT_CONFIGURED" && /QUEUE_MOCK_MODE/.test((error as Error).message),
  );
});

test("worker: thiếu cấu hình thì ném lỗi (để tiến trình thoát mã 1), không trả null âm thầm", async () => {
  const base = { ...unreachableRedis, EMBEDDING_MOCK_MODE: "true", QDRANT_MOCK_MODE: "true" } as NodeJS.ProcessEnv;
  for (const [name, env, pattern] of [
    ["thiếu REDIS_URL", { ...base, REDIS_URL: undefined }, /REDIS_URL/],
    ["thiếu Gemini key", { ...base, EMBEDDING_MOCK_MODE: undefined }, /GEMINI/],
    ["thiếu Qdrant", { ...base, QDRANT_MOCK_MODE: undefined }, /Qdrant/],
  ] as const) {
    await assert.rejects(
      () => startIndexWorker(env as NodeJS.ProcessEnv, captureLogs().log as never),
      (error: unknown) =>
        (error as { code?: string }).code === "NOT_CONFIGURED" && pattern.test((error as Error).message),
      name,
    );
  }
});

test("worker: có REDIS_URL nhưng Redis không với tới thì vẫn khởi động (không treo), tắt được sạch", async () => {
  const { logs, log } = captureLogs();
  const startedAt = Date.now();
  const worker = await startIndexWorker(
    { ...unreachableRedis, EMBEDDING_MOCK_MODE: "true", QDRANT_MOCK_MODE: "true" } as NodeJS.ProcessEnv,
    log as never,
  );

  assert.ok(Date.now() - startedAt < 2000, "khởi động không được chờ Redis");
  const started = logs.find((entry) => entry.event === "index_worker_started");
  assert.equal(started?.queue, "bullmq");
  assert.equal(started?.embedding, "mock");
  await worker.stop();
  assert.equal(JSON.stringify(logs).includes("mat-khau-bi-mat"), false);
});
