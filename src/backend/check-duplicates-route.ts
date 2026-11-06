import type { RequestHandler } from "express";
import {
  checkDuplicates,
  DEFAULT_MIN_SCORE,
  DedupError,
  type DedupDependencies,
} from "./dedup.js";
import { parseDedupInput } from "./validate-input.js";
import { assertValidDedupOutput } from "./validate-output.js";
import { createQdrantCandidateFinder } from "./candidate-source.js";
import { createScorerFromEnv, LlmScorerError } from "./llm-scorer.js";
import {
  createEmbedderFromEnv,
  EmbeddingError,
  loadEmbeddingConfig,
} from "./embeddings.js";
import { createInputEmbedder } from "./input-embedder.js";
import { createTitleSimilarity } from "./title-similarity.js";
import { createVectorStoresFromEnv } from "./qdrant-store.js";
import { VectorStoreError, lazyEnsureCollections } from "./vector-store.js";

/**
 * k của top-k: số sáng kiến gần input nhất (theo vector) được gửi cho model chấm. 20 sáng
 * kiến là 4 batch (5 ứng viên) chạy song song trong một đợt, thoải mái trong ngân sách
 * `deadlineMs` và chỉ tốn vài request model mỗi lần kiểm tra. Vector chỉ rút gọn tập ứng
 * viên nên k nhỏ đánh đổi nguy cơ bỏ sót sáng kiến trùng nhưng diễn đạt khác nhiều (xem
 * `CheckDuplicatesOptions.topK`); tăng k khi cần an toàn hơn và đo lại thời gian trả lời.
 * Tối đa 100 để một lần gọi không vượt quá một đợt song song của scorer.
 */
const DEFAULT_TOP_K = 20;
const MAX_TOP_K = 100;
/**
 * Tổng thời gian cho cả lời gọi, nhỏ hơn `timeoutMs: 30000` của tool trong
 * manifest để app tự trả lỗi có mã thay vì để Core cắt ngang. Đổi `timeoutMs` trong
 * manifest thì phải đổi cả giá trị này (và `LLM_SCORER_TIMEOUT_MS` mặc định).
 */
const DEFAULT_DEADLINE_MS = 28000;

function loadTopK(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.CHECK_DUPLICATES_TOP_K);
  return Number.isInteger(raw) && raw > 0 && raw <= MAX_TOP_K ? raw : DEFAULT_TOP_K;
}

/**
 * Ngưỡng điểm (0..100): chỉ sáng kiến có percent từ ngưỡng này trở lên được trả về (và được đưa cho
 * model làm `{{MIN_SCORE}}`). Mặc định 40 theo prompt chấm điểm; 0 giữ mọi sáng kiến đã chấm như
 * hành vi trước đây, kể cả danh sách "top 5 để tham khảo" mà VNAIP BE hiển thị khi không match nào
 * đạt 50. Giá trị sai rơi về mặc định.
 */
function loadMinScore(env: NodeJS.ProcessEnv): number {
  const raw = env.CHECK_DUPLICATES_MIN_SCORE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_SCORE;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : DEFAULT_MIN_SCORE;
}

function loadDeadlineMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.CHECK_DUPLICATES_DEADLINE_MS);
  return Number.isInteger(raw) && raw >= 1000 && raw <= 60000
    ? raw
    : DEFAULT_DEADLINE_MS;
}

/**
 * Dựng dependency thật. Luồng kiểm tra trùng embed input (embedding), tìm top-k sáng kiến
 * gần nhất ở Qdrant (đọc) rồi để model chấm điểm. Mock chỉ bật khi đặt =true tường minh
 * (EMBEDDING_MOCK_MODE, QDRANT_MOCK_MODE, LLM_MOCK_MODE): thiếu cấu hình thì ném lỗi
 * NOT_CONFIGURED thay vì âm thầm dùng dữ liệu giả.
 *
 * Mỗi lời gọi chỉ đọc collection của `input.type` (ideas / solutions / initiatives);
 * hai collection còn lại không được mở ra.
 *
 * Số chiều vector lấy từ cùng cấu hình embedding với worker (EMBEDDING_DIMENSIONS), nên
 * collection web đọc khớp collection worker ghi và vector truy vấn khớp vector đã lưu.
 */
export function buildDependencies(
  env: NodeJS.ProcessEnv = process.env,
  log: ToolLogger = defaultLog,
): DedupDependencies {
  const embeddingConfig = loadEmbeddingConfig(env);
  const stores = createVectorStoresFromEnv(env, embeddingConfig.dimensions);
  if (env.QDRANT_MOCK_MODE === "true") {
    log("info", "check_duplicates_in_memory_store", {
      message:
        "QDRANT_MOCK_MODE=true: tool đọc kho trong bộ nhớ của tiến trình web, không thấy dữ liệu do worker chạy ở tiến trình riêng ghi.",
    });
  }
  const embed = createEmbedderFromEnv(env);

  // Tạo/kiểm collection của từng type ở lần đọc đầu của type đó thay vì lúc khởi động
  // (Qdrant chậm không làm app khởi động chậm). Collection chưa có nghĩa là chưa index
  // gì; không có bước này thì lần gọi đầu trên môi trường mới sẽ lỗi 404 thay vì trả
  // danh sách rỗng.
  const ensureReady = lazyEnsureCollections(stores);

  return {
    embedInput: createInputEmbedder(embed),
    findCandidates: createQdrantCandidateFinder(stores, {
      ensureReady,
      log: (event, details) => log("info", event, details),
      // Embedding mock thì nhãn model trong dữ liệu không đồng nhất (worker ghi tên model
      // cấu hình, script seed ghi "mock-embedding"), nên chỉ kiểm khi dùng model thật.
      ...(env.EMBEDDING_MOCK_MODE === "true" ? {} : { embeddingModel: embeddingConfig.model }),
    }),
    titleSimilarities: createTitleSimilarity(embed, (event, details) => log("info", event, details)),
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
    topK: loadTopK(env),
    deadlineMs: loadDeadlineMs(env),
    minScore: loadMinScore(env),
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
        minScore: options.minScore,
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
        ...downstreamFailureField(error, detail),
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
 * Lý do gốc của lỗi chấm điểm hoặc embedding, để caller phân biệt "output bị cắt" với "hết
 * giờ", "hết quota" hay "provider từ chối" mà không cần đọc log. Chỉ áp dụng cho
 * `SCORING_UNAVAILABLE` có nguyên nhân là `LlmScorerError` và `EMBEDDING_UNAVAILABLE` có
 * nguyên nhân là `EmbeddingError`: `cause` luôn là một trong các mã cố định của chính
 * scorer/embedder (không bao giờ là `code` thô của Node/thư viện như ECONNREFUSED), còn
 * `detail` (chỉ scorer có) đã qua allow-list của `rootErrorDetail()` nên không có nội dung
 * model sinh, hồ sơ hay khoá. `NOT_CONFIGURED` bị loại vì nó nêu tên biến môi trường và
 * đã có nhánh 503 riêng.
 */
function downstreamFailureField(
  error: unknown,
  detail: Record<string, string | number> | undefined,
): { cause?: string; detail?: Record<string, string | number> } {
  if (!(error instanceof DedupError)) return {};
  const source = error.cause;
  if (error.code === "SCORING_UNAVAILABLE") {
    if (!(source instanceof LlmScorerError) || source.code === "NOT_CONFIGURED") return {};
    return { cause: source.code, ...(detail ? { detail } : {}) };
  }
  if (error.code === "EMBEDDING_UNAVAILABLE") {
    if (!(source instanceof EmbeddingError) || source.code === "NOT_CONFIGURED") return {};
    return { cause: source.code };
  }
  return {};
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
      case "EMBEDDING_UNAVAILABLE":
        return {
          status: 502,
          code: error.code,
          message: "Không thể tạo embedding cho hồ sơ đầu vào. Vui lòng thử lại sau.",
        };
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
            "Nội dung các sáng kiến cần so sánh vượt giới hạn của tool nên không thể kiểm tra đầy đủ.",
        };
      case "SCORING_UNAVAILABLE":
        return {
          status: 502,
          code: error.code,
          message: "Model chấm điểm tương đồng thất bại. Vui lòng thử lại sau.",
        };
    }
  }
  if (
    error instanceof VectorStoreError ||
    error instanceof LlmScorerError ||
    error instanceof EmbeddingError
  ) {
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
    (error instanceof VectorStoreError ||
      error instanceof LlmScorerError ||
      error instanceof EmbeddingError) &&
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
  "entryCount",
  "malformedCount",
  "unknownIdCount",
  "duplicateCount",
  "percentNotIntegerCount",
  "percentOutOfRangeCount",
  "relationInvalidCount",
  "reasonBlankCount",
  "unresolvedCount",
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
