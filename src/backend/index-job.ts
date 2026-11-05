import { chunkText, DEFAULT_CHUNK_CHARS } from "./chunker.js";
import type { Embedder } from "./embeddings.js";
import { pointId, type VectorPoint, type VectorStores } from "./vector-store.js";
import type { RecordType } from "./record-type.js";
import type { JobHandler, JobOutcome, RetryPolicy } from "./job-queue.js";
import { decideOutcome } from "./job-queue.js";

/**
 * Job index một sáng kiến. Job mang đủ thông tin để worker làm việc mà không
 * cần hỏi lại BE (id, type, title, content, metadata, fileRef); vì chứa nội dung
 * sáng kiến nên Redis phải nằm trong mạng tin cậy hoặc dùng TLS.
 *
 * `type` quyết định collection mà sáng kiến được ghi vào. Webhook đã chặn type không
 * hợp lệ trước khi enqueue, nhưng worker vẫn kiểm lại (xem processIndexJob) vì job
 * đọc từ Redis có thể là job cũ từ trước khi có các type này.
 */
export interface IndexJob {
  jobId: string;
  ideaId: string;
  type: RecordType;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  receivedAt: string;
  /**
   * #TODO(MinIO): tham chiếu file trong MinIO của VNAIP. VNAIP chưa có MinIO nên
   * worker chưa tải hay xử lý file; chỉ ghi log là đã bỏ qua.
   */
  fileRef?: string | Record<string, unknown>;
}

export class IndexJobError extends Error {
  readonly code = "TOO_LARGE" as const;
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "IndexJobError";
  }
}

export interface IndexDependencies {
  embed: Embedder;
  /** Ba store, mỗi type một collection; job được ghi vào store của `job.type`. */
  stores: VectorStores;
  /** Tên model, ghi vào payload để biết khi nào cần reindex. */
  embeddingModel: string;
  chunkChars?: number;
  maxChunks?: number;
  now?: () => Date;
  /**
   * Chạy trước khi ghi một job (ví dụ tạo collection của type đó); lỗi thì job được
   * retry. Nhận type để chỉ tạo/kiểm đúng collection sắp ghi.
   */
  ensureReady?: (type: RecordType) => Promise<void>;
}

export const DEFAULT_MAX_CHUNKS = 400;

/**
 * Idempotent: chạy lại cùng job cho cùng kết quả. Thứ tự có chủ đích:
 * embed trước (dễ lỗi nhất, chưa đụng dữ liệu), upsert chunk mới, rồi mới xoá
 * chunk thừa, nên không có lúc nào sáng kiến biến mất khỏi Qdrant.
 *
 * Cả ghi lẫn xoá chunk thừa dùng CÙNG một store (collection của `job.type`), nên
 * reindex một sáng kiến không bao giờ động tới collection của type khác, kể cả khi
 * ở đó có sáng kiến trùng `ideaId`.
 */
export async function processIndexJob(
  job: IndexJob,
  deps: IndexDependencies,
): Promise<{ chunks: number }> {
  // Chọn collection TRƯỚC mọi việc khác: type không hợp lệ (ví dụ job cũ "solution" còn
  // trong hàng đợi từ trước khi tách collection) bị loại ngay với INVALID_TYPE, không
  // retry, và không tốn lượt embedding.
  const store = deps.stores.forType(job.type);

  const chunks = chunkText(job.content, {
    maxChars: deps.chunkChars ?? DEFAULT_CHUNK_CHARS,
  });
  if (chunks.length === 0) {
    throw new IndexJobError("Sáng kiến không có nội dung để index");
  }
  if (chunks.length > (deps.maxChunks ?? DEFAULT_MAX_CHUNKS)) {
    throw new IndexJobError("Sáng kiến quá dài để index");
  }

  await deps.ensureReady?.(job.type);

  // Mỗi vector mang cả tiêu đề để chunk nào cũng giữ ngữ cảnh của sáng kiến.
  const vectors = await deps.embed(
    chunks.map((chunk) => `${job.title}\n\n${chunk}`),
  );

  const indexedAt = (deps.now?.() ?? new Date()).toISOString();
  const points: VectorPoint[] = chunks.map((content, chunkIndex) => ({
    id: pointId(job.ideaId, chunkIndex),
    vector: vectors[chunkIndex]!,
    payload: {
      ideaId: job.ideaId,
      type: job.type,
      title: job.title,
      chunkIndex,
      chunkCount: chunks.length,
      content,
      metadata: job.metadata,
      embeddingModel: deps.embeddingModel,
      indexedAt,
    },
  }));

  await store.upsertChunks(points);
  await store.deleteChunksFrom(job.ideaId, chunks.length);
  return { chunks: chunks.length };
}

export type JobLogger = (
  level: "info" | "error",
  event: string,
  details: Record<string, unknown>,
) => void;

/**
 * Biến processIndexJob thành handler cho queue: lỗi được phân loại thành
 * retry hoặc dead-letter. Log chỉ chứa định danh và mã lỗi, không có
 * title/content/fileRef.
 */
export function createIndexJobHandler(
  deps: IndexDependencies,
  policy: RetryPolicy,
  log: JobLogger,
): JobHandler<IndexJob> {
  return async (job, { attempt }): Promise<JobOutcome> => {
    const startedAt = performance.now();
    const base = {
      jobId: job.jobId,
      ideaId: job.ideaId,
      // Type là một trong ba giá trị cố định (hoặc giá trị lạ của job cũ), không phải
      // nội dung sáng kiến; ghi vào log để biết job đi vào collection nào.
      type: job.type,
      attempt,
      // #TODO(MinIO): khi có MinIO, tải file theo fileRef (quyền chỉ đọc), trích
      // text, chia chunk, rồi xoá file tạm. Hiện chỉ ghi nhận là đã bỏ qua.
      ...(job.fileRef !== undefined ? { fileSkipped: true } : {}),
    };
    try {
      const { chunks } = await processIndexJob(job, deps);
      log("info", "index_job_done", {
        ...base,
        chunks,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return { status: "done" };
    } catch (error) {
      const outcome = decideOutcome(error, attempt, policy);
      log("error", "index_job_failed", {
        ...base,
        errorCode: (error as { code?: string }).code ?? "UNKNOWN",
        outcome: outcome.status,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return outcome;
    }
  };
}
