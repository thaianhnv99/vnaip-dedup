import type { RequestHandler } from "express";
import {
  checkDuplicates,
  DedupError,
  type DedupDependencies,
} from "./dedup.js";
import { parseDedupInput } from "./validate-input.js";
import { assertValidDedupOutput } from "./validate-output.js";
import { createQdrantCandidateFinder } from "./candidate-source.js";
import { createScorerFromEnv, LlmScorerError } from "./llm-scorer.js";
import { DEFAULT_EMBEDDING_DIMENSIONS } from "./openrouter-embeddings.js";
import { createVectorStoresFromEnv } from "./qdrant-store.js";
import { VectorStoreError, lazyEnsureCollections } from "./vector-store.js";

/**
 * Trần số sáng kiến gửi cho model (hướng A gửi tất cả). 100 sáng kiến là 20 batch
 * (5 ứng viên) chạy trong MỘT đợt song song (đồng thời 20), vừa với ngân sách
 * `deadlineMs`; vượt 100 thì cần đợt thứ hai và thời gian gần gấp đôi, nên nâng trần
 * phải đo lại thời gian trả lời. Chạm trần là tín hiệu để chuyển sang hướng B
 * (top-k theo vector).
 */
const DEFAULT_CANDIDATE_LIMIT = 100;
const MAX_CANDIDATE_LIMIT = 500;
/**
 * Tổng thời gian cho cả lời gọi, nhỏ hơn `timeoutMs: 30000` của tool trong
 * manifest để app tự trả lỗi có mã thay vì để Core cắt ngang. Đổi `timeoutMs` trong
 * manifest thì phải đổi cả giá trị này (và `LLM_SCORER_TIMEOUT_MS` mặc định).
 */
const DEFAULT_DEADLINE_MS = 28000;

function loadCandidateLimit(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.CHECK_DUPLICATES_CANDIDATE_LIMIT);
  return Number.isInteger(raw) && raw > 0 && raw <= MAX_CANDIDATE_LIMIT
    ? raw
    : DEFAULT_CANDIDATE_LIMIT;
}

function loadDeadlineMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.CHECK_DUPLICATES_DEADLINE_MS);
  return Number.isInteger(raw) && raw >= 1000 && raw <= 60000
    ? raw
    : DEFAULT_DEADLINE_MS;
}

/**
 * Dựng dependency thật. Luồng 1 không embed (hướng A) nên không cần khoá embedding;
 * cần Qdrant (đọc) và model chấm điểm. Mock chỉ bật khi đặt =true tường minh
 * (QDRANT_MOCK_MODE, LLM_MOCK_MODE): thiếu cấu hình thì ném lỗi NOT_CONFIGURED thay
 * vì âm thầm dùng dữ liệu giả.
 *
 * Mỗi lời gọi chỉ đọc collection của `input.type` (ideas / solutions / initiatives);
 * hai collection còn lại không được mở ra.
 */
export function buildDependencies(
  env: NodeJS.ProcessEnv = process.env,
  log: ToolLogger = defaultLog,
): DedupDependencies {
  const stores = createVectorStoresFromEnv(env, DEFAULT_EMBEDDING_DIMENSIONS);
  if (env.QDRANT_MOCK_MODE === "true") {
    log("info", "check_duplicates_in_memory_store", {
      message:
        "QDRANT_MOCK_MODE=true: tool đọc kho trong bộ nhớ của tiến trình web, không thấy dữ liệu do worker chạy ở tiến trình riêng ghi.",
    });
  }

  // Tạo/kiểm collection của từng type ở lần đọc đầu của type đó thay vì lúc khởi động
  // (Qdrant chậm không làm app khởi động chậm). Collection chưa có nghĩa là chưa index
  // gì; không có bước này thì lần gọi đầu trên môi trường mới sẽ lỗi 404 thay vì trả
  // danh sách rỗng.
  const ensureReady = lazyEnsureCollections(stores);

  return {
    findCandidates: createQdrantCandidateFinder(stores, {
      ensureReady,
      log: (event, details) => log("info", event, details),
    }),
    scoreCandidates: createScorerFromEnv(env),
  };
}

type DependencySource = DedupDependencies | (() => DedupDependencies);

export function createCheckDuplicatesHandler(
  source: DependencySource = () => buildDependencies(),
  env: NodeJS.ProcessEnv = process.env,
  log: ToolLogger = defaultLog,
): RequestHandler {
  const options = {
    candidateLimit: loadCandidateLimit(env),
    deadlineMs: loadDeadlineMs(env),
  };

  // Chỉ nhớ lần dựng THÀNH CÔNG: cấu hình sửa xong thì lần gọi sau chạy được mà
  // không cần khởi động lại.
  let built: DedupDependencies | undefined = typeof source === "function" ? undefined : source;
  const getDependencies = (): DedupDependencies => (built ??= (source as () => DedupDependencies)());

  return async (request, response) => {
    const startedAt = performance.now();
    const requestId =
      response.getHeader("x-request-id") ??
      request.header("x-request-id") ??
      null;

    let input;
    try {
      const envelopeBody = isRecord(request.body?.body)
        ? request.body.body
        : request.body;
      input = parseDedupInput(envelopeBody?.input ?? envelopeBody);
    } catch (error) {
      response.status(400).json({
        code: "INVALID_INPUT",
        message: error instanceof Error ? error.message : "Input không hợp lệ",
        ...requestIdField(requestId),
      });
      return;
    }

    try {
      const output = await checkDuplicates(input, getDependencies(), options);

      assertValidDedupOutput(output);
      log("info", "check_duplicates_done", {
        requestId,
        matches: output.matches.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
      response.json(output);
    } catch (error) {
      const { status, code, message } = mapErrorToResponse(error);
      const detail = rootErrorDetail(error);
      log("error", "check_duplicates_failed", {
        requestId,
        code,
        status,
        durationMs: Math.round(performance.now() - startedAt),
        // Chỉ ghi mã lỗi gốc của downstream (không ghi message/cause: có thể chứa chi tiết nhạy cảm).
        ...(rootErrorCode(error) ? { cause: rootErrorCode(error) } : {}),
        // Ngoại lệ: lỗi thiếu cấu hình do chính app tạo, message chỉ nêu tên biến môi trường.
        ...(isNotConfigured(error) ? { message: (error as Error).message } : {}),
        // Meta AN TOÀN về hình dạng response của LLM provider (finish_reason, độ dài, kiểu
        // JSON), đã lọc qua allow-list — không chứa nội dung model sinh hay hồ sơ người dùng.
        ...(detail ? { detail } : {}),
      });
      response.status(status).json({
        code,
        message,
        ...requestIdField(requestId),
        ...scoringFailureField(error, detail),
      });
    }
  };
}

/**
 * Mã truy vết trả kèm lỗi để caller đối chiếu với log của app (`requestId` trong
 * `check_duplicates_failed`). Cùng giá trị với header `x-request-id`; chỉ đưa vào body
 * khi là chuỗi không rỗng.
 */
function requestIdField(requestId: unknown): { requestId?: string } {
  return typeof requestId === "string" && requestId.length > 0 ? { requestId } : {};
}

/**
 * Lý do gốc của lỗi chấm điểm, để caller phân biệt "output bị cắt" với "hết giờ" hay
 * "provider từ chối" mà không cần đọc log. Chỉ áp dụng cho `SCORING_UNAVAILABLE` có
 * nguyên nhân là `LlmScorerError`: `cause` luôn là một trong các mã cố định của scorer
 * (không bao giờ là `code` thô của Node/thư viện như ECONNREFUSED), còn `detail` đã qua
 * allow-list của `rootErrorDetail()` nên không có nội dung model sinh, hồ sơ hay khoá.
 * `NOT_CONFIGURED` bị loại vì nó nêu tên biến môi trường và đã có nhánh 503 riêng.
 */
function scoringFailureField(
  error: unknown,
  detail: Record<string, string | number> | undefined,
): { cause?: string; detail?: Record<string, string | number> } {
  if (!(error instanceof DedupError) || error.code !== "SCORING_UNAVAILABLE") return {};
  const source = error.cause;
  if (!(source instanceof LlmScorerError) || source.code === "NOT_CONFIGURED") return {};
  return { cause: source.code, ...(detail ? { detail } : {}) };
}

function mapErrorToResponse(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (isNotConfigured(error)) {
    return {
      status: 503,
      code: "TOOL_NOT_CONFIGURED",
      message: "Tool chưa được cấu hình. Vui lòng thử lại sau.",
    };
  }
  if (error instanceof DedupError) {
    switch (error.code) {
      case "INVALID_INPUT":
        return { status: 400, code: error.code, message: error.message };
      case "CANDIDATES_UNAVAILABLE":
        return {
          status: 502,
          code: error.code,
          message:
            "Không thể lấy danh sách sáng kiến để so sánh. Vui lòng thử lại sau.",
        };
      case "CANDIDATE_LIMIT_EXCEEDED":
        return {
          status: 503,
          code: error.code,
          message:
            "Số sáng kiến cần so sánh vượt giới hạn của tool nên không thể kiểm tra đầy đủ.",
        };
      case "SCORING_UNAVAILABLE":
        return {
          status: 502,
          code: error.code,
          message: "Model chấm điểm tương đồng thất bại. Vui lòng thử lại sau.",
        };
    }
  }
  if (error instanceof VectorStoreError || error instanceof LlmScorerError) {
    // Không nên lộ ra ngoài checkDuplicates() (đã được bọc thành DedupError),
    // nhưng xử lý phòng hờ để không bao giờ rơi về nhánh "lỗi nội bộ" chung.
    return {
      status: 502,
      code: error.code,
      message: "Phụ thuộc bên ngoài thất bại. Vui lòng thử lại sau.",
    };
  }

  // Output không hợp lệ theo schema, hoặc lỗi không mong đợi khác: không
  // bao giờ trả 200 với nội dung sai hợp đồng.
  return { status: 500, code: "APP_ERROR", message: "Xử lý yêu cầu thất bại." };
}

/** Lỗi thiếu cấu hình do chính app tạo ra (dựng dependency), không phải lỗi downstream. */
function isNotConfigured(error: unknown): boolean {
  return (
    (error instanceof VectorStoreError || error instanceof LlmScorerError) &&
    error.code === "NOT_CONFIGURED"
  );
}

/** Mã lỗi của downstream nằm sau DedupError (qua `cause`), để log truy được nguyên nhân. */
function rootErrorCode(error: unknown): string | undefined {
  const source = error instanceof DedupError ? error.cause : error;
  const code = (source as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Field của `detail` được phép vào log, theo kiểu; field khác bị bỏ (allow-list). */
const DETAIL_STRING_FIELDS = ["reason", "finishReason", "jsonType"] as const;
const DETAIL_NUMBER_FIELDS = [
  "contentLength",
  "topLevelKeyCount",
  "expectedCount",
  "scoredCount",
] as const;
const DETAIL_MAX_STRING_LENGTH = 64;

/**
 * Meta AN TOÀN kèm theo lỗi downstream (hiện chỉ LlmScorerError đặt), ví dụ
 * finish_reason hay độ dài output của model — dùng để debug BAD_OUTPUT.
 * Chỉ lấy field trong allow-list, đúng kiểu và có giới hạn độ dài, để dù nguồn có
 * đặt thêm field hay giá trị do model/provider kiểm soát thì log cũng không lộ
 * hồ sơ người dùng hay phình to.
 */
function rootErrorDetail(error: unknown): Record<string, string | number> | undefined {
  const source = error instanceof DedupError ? error.cause : error;
  const detail = (source as { detail?: unknown } | null)?.detail;
  if (!isRecord(detail)) return undefined;

  const safe: Record<string, string | number> = {};
  for (const key of DETAIL_STRING_FIELDS) {
    const value = detail[key];
    if (typeof value === "string") {
      safe[key] = value.slice(0, DETAIL_MAX_STRING_LENGTH);
    }
  }
  for (const key of DETAIL_NUMBER_FIELDS) {
    const value = detail[key];
    if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ToolLogger = (
  level: "info" | "error",
  event: string,
  details: Record<string, unknown>,
) => void;

function defaultLog(
  level: "info" | "error",
  event: string,
  details: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...details,
    }),
  );
}
