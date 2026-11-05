import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import type { Express, Request, RequestHandler, Response } from "express";
import { IndexEventError, parseIndexEvents } from "./index-event.js";
import type { IndexJob, JobLogger } from "./index-job.js";
import type { JobQueue } from "./job-queue.js";
import type { ReplayGuard } from "./replay-guard.js";

/**
 * Webhook index: VNAIP BE gọi thẳng, KHÔNG đi qua SotaAgents Core nên không có
 * invocation JWT và không có claims tenant (xem docs/ke-hoach-phat-trien.md,
 * mục 3.1). Route này không được khai báo trong manifest và tự xác thực bằng
 * chữ ký HMAC-SHA256 trên raw body, không phải API key tĩnh.
 *
 * Thứ tự xử lý, rẻ trước đắt sau, và KHÔNG parse JSON trước khi xác thực:
 *   1. `checkSignatureHeaders`: header chữ ký/timestamp đúng định dạng và còn
 *      hạn. Từ chối ở đây thì chưa đọc body.
 *   2. `express.raw`: đọc body nguyên bytes (mọi content-type, tối đa BODY_LIMIT).
 *   3. `handleIdeaApproved`: HMAC trên đúng bytes đó → content-type JSON →
 *      parse JSON → validate event → chống replay → enqueue.
 *
 * Body là một event (object) hoặc một mảng event. Chữ ký, chống replay và giới
 * hạn 1MB áp dụng cho cả request, không theo từng phần tử; mảng được kiểm tra
 * trọn vẹn trước khi enqueue phần tử nào.
 *
 * Không có tenant (bỏ `datasetKey`, 2026-11-04), nhưng dữ liệu được tách theo `type`:
 * mỗi type (ideas / solutions / initiatives) nằm ở một collection Qdrant riêng.
 * `type` không hợp lệ bị từ chối 400 ở `parseIndexEvents` TRƯỚC khi có job nào vào
 * hàng đợi (cả mảng bị từ chối nếu một phần tử sai). Route chỉ đẩy job vào hàng đợi
 * rồi trả 202; việc chọn collection theo `job.type` và index do worker (tiến trình
 * riêng) làm, nên tiến trình web không cần khoá Gemini/Qdrant.
 */

export const WEBHOOK_IDEA_APPROVED_PATH = "/webhooks/idea-approved";
/** Giới hạn body của webhook và của parser JSON chung (một nguồn duy nhất). */
export const BODY_LIMIT = "1mb";
export const MIN_HMAC_SECRET_LENGTH = 16;
/** Chữ ký có timestamp lệch quá biên này (giây) so với giờ server bị từ chối. */
export const HMAC_TIMESTAMP_TOLERANCE_SECONDS = 300;
/**
 * Một chữ ký có thể được chấp nhận từ `timestamp - tolerance` đến
 * `timestamp + tolerance`, nên phải nhớ nó ít nhất chừng đó (+1 giây đệm).
 */
export const REPLAY_WINDOW_SECONDS = HMAC_TIMESTAMP_TOLERANCE_SECONDS * 2 + 1;

const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i; // SHA-256 = 32 byte = 64 ký tự hex
const TIMESTAMP_PATTERN = /^[1-9]\d{0,11}$/; // epoch giây, số nguyên dạng chuẩn

export class WebhookConfigError extends Error {
  readonly code = "NOT_CONFIGURED" as const;

  constructor(message: string) {
    super(message);
    this.name = "WebhookConfigError";
  }
}

/**
 * WEBHOOK_HMAC_SECRETS gồm một hoặc nhiều secret phân tách bằng dấu phẩy. Hai
 * secret cùng hợp lệ trong lúc đổi secret, nên không cần ngừng nhận event.
 * Secret dùng để KÝ, không bao giờ gửi qua network.
 */
export function loadWebhookHmacSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const secrets = (env.WEBHOOK_HMAC_SECRETS ?? "")
    .split(",")
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0);
  if (secrets.length === 0) {
    // Môi trường cũ còn biến của cách xác thực API key: nói rõ để khỏi mất công dò.
    const legacy = (env.WEBHOOK_API_KEYS ?? "").trim().length > 0;
    throw new WebhookConfigError(
      legacy
        ? "Thiếu WEBHOOK_HMAC_SECRETS (WEBHOOK_API_KEYS đã bị thay bằng WEBHOOK_HMAC_SECRETS, xem .env.example)"
        : "Thiếu WEBHOOK_HMAC_SECRETS",
    );
  }
  if (secrets.some((secret) => secret.length < MIN_HMAC_SECRET_LENGTH)) {
    throw new WebhookConfigError(
      `Mỗi secret trong WEBHOOK_HMAC_SECRETS phải dài tối thiểu ${MIN_HMAC_SECRET_LENGTH} ký tự`,
    );
  }
  return secrets;
}

export interface WebhookDependencies {
  queue: JobQueue<IndexJob>;
  hmacSecrets: string[];
  /** Bắt buộc: không có guard thì không có chống replay, nên không cho bỏ trống. */
  replayGuard: ReplayGuard;
  log?: JobLogger;
  newJobId?: () => string;
  /** Giờ ghi vào job (`receivedAt`). KHÔNG dùng để kiểm tra chữ ký. */
  now?: () => Date;
  /** Giờ dùng kiểm tra độ lệch timestamp của chữ ký; mặc định là giờ thật. */
  authNow?: () => Date;
}

/**
 * Mount route webhook TRƯỚC parser JSON chung. Express tự quyết route nào khớp
 * (không phân biệt hoa/thường, bỏ qua dấu `/` cuối), nên không cần so khớp path
 * thủ công để loại trừ webhook khỏi parser chung: webhook khớp route này thì tự
 * trả lời và không bao giờ tới parser chung, còn lại mới qua `express.json`.
 * server.ts và test dùng chung hàm này nên test chạy đúng thứ tự thật.
 */
export function installBodyParsers(app: Express, webhook: WebhookDependencies | null): void {
  registerWebhookRoutes(app, webhook);
  app.use(express.json({ limit: BODY_LIMIT }));
}

export function registerWebhookRoutes(
  app: Express,
  deps: WebhookDependencies | null,
): void {
  if (!deps) {
    app.post(WEBHOOK_IDEA_APPROVED_PATH, webhookNotConfigured);
    return;
  }
  app.post(WEBHOOK_IDEA_APPROVED_PATH, createIdeaApprovedHandlers(deps));
}

const webhookNotConfigured: RequestHandler = (_request, response) => {
  response.status(503).json({
    code: "WEBHOOK_NOT_CONFIGURED",
    message: "Webhook index chưa được cấu hình. Vui lòng thử lại sau.",
  });
};

/** Kết quả bước 1, truyền sang bước 3 qua `response.locals`. */
interface PresentedSignature {
  digest: Buffer;
  /** Nguyên văn header timestamp: chữ ký phủ đúng chuỗi này, không phải số đã parse. */
  timestamp: string;
}

type Rejection =
  | "missing_signature"
  | "missing_timestamp"
  | "invalid_timestamp"
  | "stale_timestamp"
  | "invalid_signature";

export function createIdeaApprovedHandlers(deps: WebhookDependencies): RequestHandler[] {
  const log = deps.log ?? defaultLog;
  return [
    checkSignatureHeaders(deps, log),
    // `type: () => true`: đọc mọi content-type thành Buffer để HMAC luôn tính trên
    // đúng bytes đã gửi; content-type sai được báo rõ (415) sau khi xác thực.
    express.raw({ type: () => true, limit: BODY_LIMIT }),
    handleIdeaApproved(deps, log),
  ];
}

function reject(
  response: Response,
  log: JobLogger,
  reason: Rejection | "unsupported_media_type" | "replayed_signature",
) {
  log("error", "webhook_rejected", { requestId: requestIdOf(response), reason });
}

/**
 * Bước 1: kiểm tra những gì không cần body. Header sai/thiếu/hết hạn bị từ chối
 * trước khi server đọc 1 byte body nào.
 */
function checkSignatureHeaders(deps: WebhookDependencies, log: JobLogger): RequestHandler {
  const authNow = deps.authNow ?? (() => new Date());

  return (request, response, next) => {
    const verdict = readSignatureHeaders(request, authNow());
    if (typeof verdict === "string") {
      reject(response, log, verdict);
      response.status(401).json({ code: "AUTH_ERROR", message: "Chữ ký không hợp lệ" });
      return;
    }
    response.locals.webhookSignature = verdict;
    next();
  };
}

function readSignatureHeaders(request: Request, now: Date): PresentedSignature | Rejection {
  const signatureHeader = request.header("x-webhook-signature");
  if (!signatureHeader) return "missing_signature";
  const presentedHex = signatureHeader.trim().replace(/^sha256=/i, "");
  if (!SIGNATURE_PATTERN.test(presentedHex)) return "invalid_signature";

  const timestamp = request.header("x-webhook-timestamp");
  if (!timestamp) return "missing_timestamp";
  // Chặt hơn Number(): không nhận số 0 đầu dòng, mũ, hex hay phần thập phân, vì
  // chữ ký phủ đúng chuỗi header nên định dạng phải là một dạng duy nhất.
  if (!TIMESTAMP_PATTERN.test(timestamp)) return "invalid_timestamp";
  const skewSeconds = Math.abs(now.getTime() / 1000 - Number(timestamp));
  if (skewSeconds > HMAC_TIMESTAMP_TOLERANCE_SECONDS) return "stale_timestamp";

  return { digest: Buffer.from(presentedHex, "hex"), timestamp };
}

/** Bước 3: xác thực trên raw bytes rồi mới đụng tới nội dung. */
function handleIdeaApproved(deps: WebhookDependencies, log: JobLogger): RequestHandler {
  const now = deps.now ?? (() => new Date());

  return async (request, response) => {
    const requestId = requestIdOf(response);
    const receivedAt = now(); // đọc đúng một lần mỗi request
    const presented = response.locals.webhookSignature as PresentedSignature;
    // Body rỗng thì express.raw để `request.body` là undefined: coi như 0 byte.
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

    if (!signatureMatches(deps.hmacSecrets, presented, rawBody)) {
      reject(response, log, "invalid_signature");
      response.status(401).json({ code: "AUTH_ERROR", message: "Chữ ký không hợp lệ" });
      return;
    }

    // `is("json")` trả null khi không có body: để JSON.parse báo 400 bên dưới.
    if (request.is("json") === false) {
      reject(response, log, "unsupported_media_type");
      response.status(415).json({
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type phải là application/json",
      });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      response.status(400).json({ code: "BAD_REQUEST", message: "Request không hợp lệ" });
      return;
    }

    // Cả mảng được kiểm tra xong rồi mới giữ chỗ replay hay enqueue: một phần tử
    // sai thì không phần tử nào được nhận.
    let jobs: IndexJob[];
    let batch: boolean;
    try {
      const parsed = parseIndexEvents(payload);
      batch = parsed.batch;
      const receivedAtIso = receivedAt.toISOString();
      jobs = parsed.events.map((event) => ({
        jobId: (deps.newJobId ?? randomUUID)(),
        ideaId: event.ideaId,
        type: event.type,
        title: event.title,
        content: event.content,
        metadata: event.metadata,
        receivedAt: receivedAtIso,
        ...(event.fileRef !== undefined ? { fileRef: event.fileRef } : {}),
      }));
    } catch (error) {
      if (error instanceof IndexEventError) {
        response.status(400).json({ code: error.code, message: error.message });
        return;
      }
      throw error;
    }

    // Chỉ giữ chỗ khi event đã hợp lệ (không đốt khoá vì request sai định dạng).
    const replayKey = presented.digest.toString("hex");
    try {
      if (!(await deps.replayGuard.claim(replayKey, REPLAY_WINDOW_SECONDS))) {
        reject(response, log, "replayed_signature");
        response.status(409).json({
          code: "DUPLICATE_DELIVERY",
          message: "Request này đã được nhận trước đó",
        });
        return;
      }
    } catch (error) {
      // Không kiểm tra được replay thì không nhận: fail closed, bên gửi sẽ gửi lại.
      log("error", "webhook_replay_guard_failed", {
        requestId,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      response.status(503).json(queueUnavailable);
      return;
    }

    // Enqueue lần lượt đúng thứ tự mảng: worker chạy tuần tự FIFO nên cùng một
    // `id` xuất hiện hai lần trong mảng thì phần tử sau ghi đè phần tử trước,
    // giống hai request riêng gửi nối tiếp.
    let enqueued = 0;
    try {
      for (const job of jobs) {
        await deps.queue.publish(job);
        enqueued += 1;
      }
    } catch (error) {
      const failed = jobs[enqueued]!;
      log("error", "webhook_enqueue_failed", {
        requestId,
        jobId: failed.jobId,
        ideaId: failed.ideaId,
        enqueued,
        batchSize: jobs.length,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      // Event chưa được nhận nên trả chỗ, để gửi lại đúng request này vẫn được.
      // Mảng có thể đã vào hàng đợi một phần (broker không có giao dịch nhiều job
      // trong giao diện JobQueue); gửi lại cả mảng vẫn an toàn vì index theo `id`
      // là idempotent: các phần tử đã vào hàng đợi chỉ bị index lại cùng nội dung.
      await deps.replayGuard.release(replayKey).catch(() => undefined);
      response.status(503).json(queueUnavailable);
      return;
    }

    for (const job of jobs) {
      log("info", "webhook_accepted", {
        requestId,
        jobId: job.jobId,
        ideaId: job.ideaId,
        hasFileRef: job.fileRef !== undefined,
        batchSize: jobs.length,
      });
    }
    if (batch) {
      // `id` là mã sáng kiến BE tự gửi (không nhạy cảm), trả lại để BE đối chiếu
      // từng phần tử với `jobId` mà không phải dựa vào vị trí.
      response.status(202).json({
        status: "accepted",
        count: jobs.length,
        jobs: jobs.map((job) => ({ id: job.ideaId, jobId: job.jobId })),
      });
      return;
    }
    response.status(202).json({ status: "accepted", jobId: jobs[0]!.jobId });
  };
}

const queueUnavailable = {
  code: "QUEUE_UNAVAILABLE",
  message: "Chưa nhận được event. Vui lòng gửi lại sau.",
} as const;

/**
 * Chữ ký là hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`)) tính trên đúng
 * bytes VNAIP BE đã gửi, không phải JSON đã parse rồi stringify lại (thứ tự
 * field/khoảng trắng có thể khác, làm sai HMAC). Thử hết mọi secret (không
 * thoát sớm) để thời gian phản hồi không lộ secret nào khớp.
 */
function signatureMatches(
  secrets: string[],
  presented: PresentedSignature,
  rawBody: Buffer,
): boolean {
  const prefix = Buffer.from(`${presented.timestamp}.`, "utf8");
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(prefix).update(rawBody).digest();
    if (timingSafeEqual(presented.digest, expected)) matched = true;
  }
  return matched;
}

function requestIdOf(response: Response): string | number | string[] | null {
  return response.getHeader("x-request-id") ?? null;
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
