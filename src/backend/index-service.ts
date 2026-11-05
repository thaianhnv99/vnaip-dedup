import {
  createEmbedderFromEnv,
  loadEmbeddingConfig,
  EmbeddingError,
} from "./embeddings.js";
import { createVectorStoresFromEnv } from "./qdrant-store.js";
import { VectorStoreError, lazyEnsureCollections } from "./vector-store.js";
import {
  InMemoryJobQueue,
  loadRetryPolicy,
  type JobHandler,
  type JobQueue,
} from "./job-queue.js";
import {
  createIndexJobHandler,
  type IndexJob,
  type JobLogger,
} from "./index-job.js";
import {
  WebhookConfigError,
  loadWebhookHmacSecrets,
  type WebhookDependencies,
} from "./webhook-routes.js";
import {
  BullMqError,
  BullMqJobQueue,
  loadBullMqConfig,
} from "./bullmq-queue.js";
import {
  InMemoryReplayGuard,
  createRedisReplayGuard,
  type ReplayGuard,
} from "./replay-guard.js";

/**
 * Luồng index: webhook → queue → worker → embedding → Qdrant, chia hai vai chạy
 * ở hai tiến trình khác nhau (quyết định 2026-11-04):
 *
 * - Web (`server.ts`): `startWebhookService` chỉ nhận event, kiểm tra rồi đẩy job
 *   vào hàng đợi. Không cần khoá Gemini hay Qdrant, và việc xử lý nặng của
 *   worker (trích text bằng CPU khi có MinIO) không chặn webhook hay /health.
 * - Worker (`worker.ts`): `startIndexWorker` lấy job từng cái một, embed, ghi
 *   Qdrant. Web và worker phải dùng cùng REDIS_URL, QUEUE_PREFIX và QUEUE_NAME.
 *
 * Ngoại lệ duy nhất: QUEUE_MOCK_MODE=true dùng hàng đợi trong bộ nhớ, không chia
 * sẻ được giữa hai tiến trình, nên web tự chạy worker ngay trong tiến trình
 * (chỉ để phát triển cục bộ).
 */

export interface WebhookService {
  webhook: WebhookDependencies;
  stop(): Promise<void>;
}

export interface IndexWorker {
  stop(): Promise<void>;
}

export class IndexServiceConfigError extends Error {
  readonly code = "NOT_CONFIGURED" as const;

  constructor(message: string) {
    super(message);
    this.name = "IndexServiceConfigError";
  }
}

/**
 * Phía web. Trả về null (và ghi log) khi cấu hình chưa đủ, để app vẫn khởi
 * động, vẫn trả /health và vẫn phục vụ tool; khi đó webhook trả 503 thay vì làm
 * app sập.
 */
export async function startWebhookService(
  env: NodeJS.ProcessEnv = process.env,
  log: JobLogger = defaultLog,
): Promise<WebhookService | null> {
  try {
    const hmacSecrets = loadWebhookHmacSecrets(env);
    // Cách xác thực cũ (x-api-key) không còn được nhận: nhắc để khỏi tưởng nó còn hiệu lực.
    if ((env.WEBHOOK_API_KEYS ?? "").trim().length > 0) {
      log("error", "webhook_legacy_api_keys_ignored", {
        message:
          "WEBHOOK_API_KEYS không còn được dùng; webhook chỉ nhận chữ ký HMAC (WEBHOOK_HMAC_SECRETS). VNAIP BE phải đổi sang ký HMAC cùng lúc.",
      });
    }
    const queue = createQueueFromEnv(env, log);
    const replayGuard = createReplayGuardFromEnv(env, log);

    // Hàng đợi trong bộ nhớ không chia sẻ được giữa các tiến trình nên worker
    // phải chạy cùng tiến trình. Với BullMQ thì worker là tiến trình riêng.
    const inline = isMockQueue(env);
    const consumer = inline
      ? await queue.startConsuming(buildIndexHandler(env, log))
      : null;
    // Mở kết nối Redis ngay để lỗi kết nối hiện trong log lúc khởi động thay vì
    // chờ đến event đầu tiên. Không chờ kết quả: Redis chậm không làm app chậm.
    if (!inline) queue.warmUp?.();

    log("info", "webhook_service_started", {
      queue: inline ? "in-memory" : "bullmq",
      worker: inline ? "inline" : "external",
    });

    return {
      webhook: { queue, hmacSecrets, replayGuard, log },
      stop: async () => {
        await consumer?.stop();
        await queue.close?.();
        await replayGuard.close?.();
      },
    };
  } catch (error) {
    log("error", "index_service_disabled", describeStartupError(error));
    return null;
  }
}

/**
 * Phía worker. Ném lỗi khi cấu hình thiếu (khác với web): worker không có việc gì
 * khác để làm, nên tiến trình phải thoát mã lỗi để nền tảng báo hỏng ngay.
 */
export async function startIndexWorker(
  env: NodeJS.ProcessEnv = process.env,
  log: JobLogger = defaultLog,
): Promise<IndexWorker> {
  if (isMockQueue(env)) {
    throw new IndexServiceConfigError(
      "QUEUE_MOCK_MODE=true dùng hàng đợi trong bộ nhớ nên không chạy được ở tiến trình worker riêng; web đã tự chạy worker ở chế độ này",
    );
  }
  const embeddingConfig = loadEmbeddingConfig(env);
  const handler = buildIndexHandler(env, log);
  const queue = createQueueFromEnv(env, log);

  let consumer: { stop(): Promise<void> };
  try {
    consumer = await queue.startConsuming(handler);
  } catch (error) {
    await queue.close?.();
    throw error;
  }

  log("info", "index_worker_started", {
    queue: "bullmq",
    embedding: env.EMBEDDING_MOCK_MODE === "true" ? "mock" : embeddingConfig.model,
    vectorStore: env.QDRANT_MOCK_MODE === "true" ? "in-memory" : "qdrant",
  });

  return {
    stop: async () => {
      await consumer.stop();
      await queue.close?.();
    },
  };
}

function buildIndexHandler(env: NodeJS.ProcessEnv, log: JobLogger): JobHandler<IndexJob> {
  const embeddingConfig = loadEmbeddingConfig(env);
  const embed = createEmbedderFromEnv(env);
  // Ba store, mỗi type (ideas / solutions / initiatives) một collection; job được ghi
  // vào store của đúng `job.type`.
  const stores = createVectorStoresFromEnv(env, embeddingConfig.dimensions);

  // Tạo collection ở job đầu tiên của từng type thay vì lúc khởi động, để Qdrant chậm
  // hay lỗi không làm tiến trình khởi động chậm; lỗi thì job được retry.
  const ensureReady = lazyEnsureCollections(stores);

  return createIndexJobHandler(
    { embed, stores, embeddingModel: embeddingConfig.model, ensureReady },
    loadRetryPolicy(env),
    log,
  );
}

function isMockQueue(env: NodeJS.ProcessEnv): boolean {
  return env.QUEUE_MOCK_MODE === "true";
}

/**
 * QUEUE_MOCK_MODE=true dùng hàng đợi trong bộ nhớ (job mất khi tiến trình tắt,
 * chỉ cục bộ). Không đặt nghĩa là dùng BullMQ (Redis) và báo lỗi cấu hình nếu
 * thiếu REDIS_URL, để hosted không âm thầm chạy bằng hàng đợi tạm.
 */
function createQueueFromEnv(env: NodeJS.ProcessEnv, log: JobLogger): JobQueue<IndexJob> {
  if (isMockQueue(env)) return new InMemoryJobQueue<IndexJob>();
  return new BullMqJobQueue<IndexJob>(loadBullMqConfig(env, loadRetryPolicy(env)), log);
}

/**
 * Chống replay dùng chung Redis với hàng đợi để mọi instance web cùng thấy một
 * tập chữ ký đã nhận. Chế độ mock chỉ có một tiến trình nên dùng bộ nhớ.
 */
function createReplayGuardFromEnv(env: NodeJS.ProcessEnv, log: JobLogger): ReplayGuard {
  if (isMockQueue(env)) return new InMemoryReplayGuard();
  const config = loadBullMqConfig(env, loadRetryPolicy(env));
  return createRedisReplayGuard(config.connection, `${config.prefix}:webhook-replay:`, log);
}

/** Chỉ lỗi cấu hình do app tự tạo mới được ghi message; lỗi khác chỉ ghi tên. */
export function describeStartupError(error: unknown): Record<string, unknown> {
  const known =
    error instanceof IndexServiceConfigError ||
    error instanceof WebhookConfigError ||
    error instanceof BullMqError ||
    error instanceof EmbeddingError ||
    error instanceof VectorStoreError;
  return {
    errorName: error instanceof Error ? error.name : "unknown",
    errorCode: (error as { code?: string } | null)?.code ?? "UNKNOWN",
    ...(known ? { message: (error as Error).message } : {}),
  };
}

function defaultLog(
  level: "info" | "error",
  event: string,
  details: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }),
  );
}
