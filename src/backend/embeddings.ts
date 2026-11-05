import { createHash } from "node:crypto";

/**
 * Embedding client qua Gemini: POST {baseUrl}/embeddings (endpoint tương thích
 * OpenAI của Gemini API). Model mặc định gemini-embedding-001 mặc định ra 3072
 * chiều nhưng cắt được về 128..3072 (khuyến nghị 768, 1536, 3072), nên request
 * luôn gửi `dimensions` để ra đúng 1536 chiều, khớp collection Qdrant đã tạo.
 * Model dùng khi query PHẢI trùng model dùng khi index, nên model được ghi vào
 * payload của từng point (xem vector-store.ts).
 *
 * Client này không tự retry: worker index (GĐ2) quyết định retry dựa trên
 * `error.retryable`. Thông báo lỗi chỉ chứa mã HTTP, không bao giờ chứa API
 * key, nội dung văn bản gửi đi hay body phản hồi của provider.
 */

export const DEFAULT_GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Số chiều kỳ vọng; response sai số chiều bị coi là BAD_RESPONSE. */
  dimensions: number;
  timeoutMs: number;
  /** Số văn bản tối đa trong một request. */
  batchSize: number;
}

export type EmbeddingErrorCode =
  | "NOT_CONFIGURED"
  | "INVALID_INPUT"
  | "AUTH_ERROR"
  | "BAD_REQUEST"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "BAD_RESPONSE";

const RETRYABLE_CODES: ReadonlySet<EmbeddingErrorCode> = new Set([
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "TIMEOUT",
  "NETWORK_ERROR",
]);

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly retryable: boolean;

  constructor(
    code: EmbeddingErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.name = "EmbeddingError";
  }
}

/** Biến văn bản thành vector, giữ nguyên thứ tự đầu vào. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadEmbeddingConfig(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingConfig {
  return {
    baseUrl: (env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL).replace(
      /\/+$/,
      "",
    ),
    apiKey: env.GEMINI_API_KEY ?? "",
    model: env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
    dimensions: positiveInteger(
      env.EMBEDDING_DIMENSIONS,
      DEFAULT_EMBEDDING_DIMENSIONS,
    ),
    timeoutMs: positiveInteger(env.EMBEDDING_TIMEOUT_MS, 15000),
    batchSize: positiveInteger(env.EMBEDDING_BATCH_SIZE, 64),
  };
}

/**
 * Mock chỉ bật khi EMBEDDING_MOCK_MODE=true. Biến không đặt nghĩa là dùng
 * client thật (và báo NOT_CONFIGURED nếu thiếu key) để production không bao
 * giờ âm thầm chạy bằng vector giả.
 */
export function createEmbedderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Embedder {
  const config = loadEmbeddingConfig(env);
  return env.EMBEDDING_MOCK_MODE === "true"
    ? createMockEmbedder(config.dimensions)
    : createHttpEmbedder(config);
}

export function createHttpEmbedder(config: EmbeddingConfig): Embedder {
  if (!config.apiKey) {
    throw new EmbeddingError(
      "NOT_CONFIGURED",
      "Embedding chưa được cấu hình (thiếu GEMINI_API_KEY; OPENROUTER_API_KEY không còn được đọc)",
    );
  }

  return async function embed(texts: string[]): Promise<number[][]> {
    assertTexts(texts);
    const vectors: number[][] = [];
    // Tuần tự có chủ ý: queue index chạy tuần tự để kiểm soát tải lên Gemini (free tier giới hạn request mỗi phút).
    for (let start = 0; start < texts.length; start += config.batchSize) {
      const batch = texts.slice(start, start + config.batchSize);
      vectors.push(...(await embedBatch(batch, config)));
    }
    return vectors;
  };
}

async function embedBatch(
  batch: string[],
  config: EmbeddingConfig,
): Promise<number[][]> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: batch,
        encoding_format: "float",
        dimensions: config.dimensions,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw transportError(error);
  }

  if (!response.ok) {
    // Không đọc body lỗi: nó có thể chứa nội dung đã gửi đi.
    void response.body?.cancel().catch(() => undefined);
    throw statusError(response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isTimeout(error)) throw transportError(error);
    throw new EmbeddingError(
      "BAD_RESPONSE",
      "Gemini trả response không phải JSON hợp lệ",
      { cause: error },
    );
  }

  return parseEmbeddings(body, batch.length, config.dimensions);
}

function parseEmbeddings(
  body: unknown,
  expectedCount: number,
  dimensions: number,
): number[][] {
  if (
    !isRecord(body) ||
    !Array.isArray(body.data) ||
    body.data.length !== expectedCount
  ) {
    throw new EmbeddingError(
      "BAD_RESPONSE",
      "Gemini trả số embedding không khớp số văn bản đã gửi",
    );
  }

  const ordered: Array<number[] | undefined> = new Array(expectedCount).fill(
    undefined,
  );
  for (const item of body.data) {
    if (
      !isRecord(item) ||
      !Number.isInteger(item.index) ||
      (item.index as number) < 0 ||
      (item.index as number) >= expectedCount ||
      ordered[item.index as number] !== undefined ||
      !Array.isArray(item.embedding) ||
      item.embedding.length !== dimensions ||
      !item.embedding.every(
        (value: unknown) => typeof value === "number" && Number.isFinite(value),
      )
    ) {
      throw new EmbeddingError(
        "BAD_RESPONSE",
        `Gemini trả embedding sai định dạng hoặc sai số chiều (kỳ vọng ${dimensions})`,
      );
    }
    ordered[item.index as number] = item.embedding as number[];
  }

  return ordered as number[][];
}

function statusError(status: number): EmbeddingError {
  if (status === 401 || status === 403) {
    return new EmbeddingError(
      "AUTH_ERROR",
      `Gemini từ chối xác thực (HTTP ${status})`,
    );
  }
  if (status === 408 || status === 429) {
    return new EmbeddingError(
      "RATE_LIMITED",
      `Gemini giới hạn tốc độ/hết quota hoặc quá thời gian (HTTP ${status})`,
    );
  }
  if (status >= 500) {
    return new EmbeddingError(
      "UPSTREAM_ERROR",
      `Gemini trả lỗi máy chủ (HTTP ${status})`,
    );
  }
  return new EmbeddingError(
    "BAD_REQUEST",
    `Gemini từ chối request (HTTP ${status})`,
  );
}

function transportError(error: unknown): EmbeddingError {
  if (isTimeout(error)) {
    return new EmbeddingError(
      "TIMEOUT",
      "Gọi Gemini quá thời gian cho phép",
      { cause: error },
    );
  }
  return new EmbeddingError("NETWORK_ERROR", "Không thể kết nối tới Gemini", {
    cause: error,
  });
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function assertTexts(texts: string[]): void {
  if (
    !Array.isArray(texts) ||
    texts.some((text) => typeof text !== "string" || text.trim().length === 0)
  ) {
    throw new EmbeddingError(
      "INVALID_INPUT",
      "Văn bản cần embedding phải là chuỗi không rỗng",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Embedding giả, xác định (cùng văn bản cho cùng vector), chỉ để phát triển và
 * test khi chưa có khoá Gemini. Dùng túi từ băm rồi chuẩn hoá L2 nên văn bản
 * chung nhiều từ cho vector gần nhau. KHÔNG dùng trong production.
 */
export function createMockEmbedder(
  dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Embedder {
  return async function embedMock(texts: string[]): Promise<number[][]> {
    assertTexts(texts);
    return texts.map((text) => hashedBagOfWords(text, dimensions));
  };
}

function hashedBagOfWords(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words = text
    .toLowerCase()
    .normalize("NFC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);

  for (const term of words.length > 0 ? words : [text]) {
    const digest = createHash("sha256").update(term).digest();
    vector[digest.readUInt32BE(0) % dimensions] += 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}
