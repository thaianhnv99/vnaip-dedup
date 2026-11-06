import { DedupError, roundSimilarity, type Candidate, type DedupDependencies } from "./dedup.js";
import type { RecordType } from "./record-type.js";
import {
  DEFAULT_MAX_SCROLL_POINTS,
  type StoredChunk,
  type VectorStores,
} from "./vector-store.js";

/**
 * Nguồn ứng viên của luồng kiểm tra trùng (hướng B, top-k theo vector), chạy sau bước
 * embed input:
 *
 * 1. Tìm trong collection CỦA ĐÚNG type được hỏi `query.limit` sáng kiến gần vector truy
 *    vấn nhất (đã loại `excludeIds` ngay trong truy vấn).
 * 2. Đọc MỌI chunk của các sáng kiến đó rồi gom lại theo `ideaId`, vì model phải chấm trên
 *    nội dung đầy đủ chứ không phải đúng đoạn vừa khớp vector.
 *
 * Collection của type khác không bao giờ được mở ra (type được tách ở tầng lưu trữ, không
 * phải đọc hết rồi lọc). Vector chỉ dùng để rút gọn tập ứng viên; xem `CheckDuplicatesOptions.topK`
 * về nguy cơ bỏ sót.
 *
 * Không còn `datasetKey`, nên hàm này không lọc theo tenant; ai được gọi tool do
 * caller-policy.ts quyết định.
 */

export interface CandidateSourceOptions {
  /**
   * Số chunk tối đa đọc khi lấy nội dung đầy đủ của các sáng kiến tìm được; chạm trần thì
   * báo lỗi, không trả dữ liệu thiếu.
   */
  maxPoints?: number;
  /**
   * Chạy trước lần đọc đầu tiên của MỘT type (ví dụ ensureCollection của collection
   * type đó); lỗi thì lần sau thử lại.
   */
  ensureReady?: (type: RecordType) => Promise<void>;
  log?: (event: string, details: Record<string, unknown>) => void;
  /**
   * Model đã embed input. Khi đặt, mọi sáng kiến tìm được phải do chính model này index:
   * vector của model khác (hoặc vector giả của script seed) không so sánh được với vector
   * truy vấn nên thứ hạng vô nghĩa, và trả kết quả như thể hợp lệ sẽ bỏ sót sáng kiến
   * trùng. Lệch thì báo lỗi (cần index lại), không trả danh sách sai. Không đặt (embedding
   * mock) thì bỏ qua kiểm tra vì nhãn model trong dữ liệu mock không đồng nhất.
   */
  embeddingModel?: string;
}

/** Chấp nhận cả "gemini-embedding-001" lẫn "models/gemini-embedding-001" (xem embeddings.ts). */
function normalizeModel(model: string): string {
  return model.replace(/^models\//, "");
}

export function createQdrantCandidateFinder(
  stores: VectorStores,
  options: CandidateSourceOptions = {},
): DedupDependencies["findCandidates"] {
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_SCROLL_POINTS;

  return async function findCandidates(input, query) {
    const startedAt = performance.now();
    // Chọn collection theo type TRƯỚC mọi thao tác: type lạ thì dừng ở đây.
    const store = stores.forType(input.type);
    await options.ensureReady?.(input.type);

    const hits = await store.searchIdeas({
      vectors: query.vectors,
      limit: query.limit,
      excludeIdeaIds: input.excludeIds,
    });

    if (options.embeddingModel !== undefined) {
      const expected = normalizeModel(options.embeddingModel);
      const mismatched = hits.filter((hit) => normalizeModel(hit.embeddingModel) !== expected);
      if (mismatched.length > 0) {
        options.log?.("candidates_embedding_model_mismatch", {
          type: input.type,
          expected,
          indexedWith: [...new Set(mismatched.map((hit) => hit.embeddingModel))].slice(0, 5),
          hits: hits.length,
          mismatched: mismatched.length,
        });
        throw new DedupError(
          "CANDIDATES_UNAVAILABLE",
          "Vector đã index do embedding model khác model dùng để embed input; cần index lại",
        );
      }
    }

    if (hits.length === 0) {
      options.log?.("candidates_loaded", {
        type: input.type,
        queryVectors: query.vectors.length,
        hits: 0,
        chunks: 0,
        ideas: 0,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return [];
    }

    const { points, truncated } = await store.scrollIdeas(
      hits.map((hit) => hit.ideaId),
      { maxPoints },
    );
    if (truncated) {
      // Thiếu chunk nghĩa là một ứng viên bị cụt nội dung; model chấm trên nội dung thiếu
      // sẽ cho điểm sai, nên coi như vượt trần.
      throw new DedupError(
        "CANDIDATE_LIMIT_EXCEEDED",
        "Nội dung các sáng kiến tìm được vượt giới hạn đọc của luồng kiểm tra trùng",
      );
    }

    // Collection của type này không được chứa chunk mang type khác. Nếu có thì dữ liệu
    // đã bị ghi lệch (sửa tay, migrate sai...): bỏ qua chúng (xem groupChunksIntoCandidates)
    // và để lại dấu vết trong log thay vì im lặng.
    const foreign = points.filter((chunk) => chunk.payload.type !== input.type).length;
    if (foreign > 0) {
      options.log?.("candidates_foreign_type_ignored", { type: input.type, chunks: foreign });
    }

    // Giữ thứ hạng theo độ gần (gần nhất trước). Sáng kiến vừa bị xoá giữa lúc tìm và lúc
    // đọc không còn chunk nào nên bị bỏ qua; nó không còn tồn tại nên không phải bỏ sót.
    const matchedIndexes = new Map(hits.map((hit) => [hit.ideaId, hit.chunkIndexes]));
    const byId = new Map(
      groupChunksIntoCandidates(points, input.type, matchedIndexes).map((candidate) => [
        candidate.id,
        candidate,
      ]),
    );
    const candidates = hits.flatMap((hit) => {
      const candidate = byId.get(hit.ideaId);
      // contentSimilarity là cosine của chunk gần nhất (đã gồm tiêu đề, vì mỗi chunk được embed
      // cùng tiêu đề, xem embeddingText); rõ ràng khác titleSimilarity (chỉ tiêu đề).
      return candidate ? [{ ...candidate, contentSimilarity: roundSimilarity(hit.score) }] : [];
    });

    options.log?.("candidates_loaded", {
      type: input.type,
      queryVectors: query.vectors.length,
      hits: hits.length,
      chunks: points.length,
      ideas: candidates.length,
      // Điểm cosine của sáng kiến gần nhất và xa nhất trong top-k: để biết top-k có đang
      // cắt ở vùng còn rất giống (nguy cơ bỏ sót) hay đã chạm vùng không liên quan.
      topScore: roundScore(hits[0]!.score),
      lastScore: roundScore(hits[hits.length - 1]!.score),
      durationMs: Math.round(performance.now() - startedAt),
    });
    return candidates;
  };
}

function roundScore(score: number): number {
  return Math.round(score * 10000) / 10000;
}

/**
 * Ghép các chunk của cùng một sáng kiến lại thành một ứng viên.
 *
 * Index lại một sáng kiến ghi đè chunk 0..n-1 rồi mới xoá chunk thừa (xem
 * index-job.ts), nên lúc đọc có thể thấy chunk của hai lần index lẫn nhau. Quy
 * tắc: lấy lần index MỚI NHẤT (theo `indexedAt`) làm chuẩn cho tiêu đề và số
 * chunk, bỏ chunk có chỉ số >= số chunk đó (đuôi cũ chưa kịp xoá), và nếu một chỉ
 * số có nhiều bản thì lấy bản mới hơn. Không bỏ cả sáng kiến chỉ vì thiếu chunk:
 * làm vậy sẽ che mất một sáng kiến có thể trùng.
 *
 * `matchedChunkIndexes` (ideaId -> chỉ số chunk khớp vector truy vấn, gần nhất trước) cho
 * ra `matchedChunks`: nội dung các chunk đó theo lần index mới nhất. Chỉ số không còn chunk
 * (sáng kiến vừa index lại ngắn hơn) thì bỏ qua.
 *
 * `chunks` phải đến từ collection của `type`; việc tách type KHÔNG dựa vào dòng lọc
 * bên dưới. Dòng đó chỉ là chốt chặn thứ hai: chunk mang type khác (không thể xuất
 * hiện nếu dữ liệu được ghi qua store) không bao giờ trở thành ứng viên của `type`.
 */
export function groupChunksIntoCandidates(
  chunks: StoredChunk[],
  type: RecordType,
  matchedChunkIndexes: ReadonlyMap<string, readonly number[]> = new Map(),
): Candidate[] {
  const byIdea = new Map<string, StoredChunk[]>();
  for (const chunk of chunks) {
    if (chunk.payload.type !== type) continue;
    const list = byIdea.get(chunk.payload.ideaId);
    if (list) list.push(chunk);
    else byIdea.set(chunk.payload.ideaId, [chunk]);
  }

  const candidates: Candidate[] = [];
  for (const [ideaId, list] of byIdea) {
    const newest = list.reduce((best, chunk) =>
      chunk.payload.indexedAt > best.payload.indexedAt ? chunk : best,
    );

    const byIndex = new Map<number, StoredChunk>();
    for (const chunk of list) {
      if (chunk.payload.chunkIndex >= newest.payload.chunkCount) continue;
      const current = byIndex.get(chunk.payload.chunkIndex);
      if (!current || chunk.payload.indexedAt > current.payload.indexedAt) {
        byIndex.set(chunk.payload.chunkIndex, chunk);
      }
    }

    const content = [...byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, chunk]) => chunk.payload.content)
      .join("\n\n");

    const matchedChunks = (matchedChunkIndexes.get(ideaId) ?? []).flatMap((chunkIndex) => {
      const chunk = byIndex.get(chunkIndex);
      return chunk ? [chunk.payload.content] : [];
    });

    candidates.push({
      id: ideaId,
      type,
      title: newest.payload.title,
      content,
      ...(matchedChunks.length > 0 ? { matchedChunks } : {}),
    });
  }

  // Thứ tự xác định để chia batch ổn định giữa các lần gọi.
  return candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
