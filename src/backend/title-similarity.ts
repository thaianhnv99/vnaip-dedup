import type { DedupDependencies } from "./dedup.js";
import { EmbeddingError, type Embedder } from "./embeddings.js";
import { cosine } from "./vector-store.js";

/**
 * `titleSimilarity` của prompt chấm điểm: cosine giữa vector của tiêu đề input và vector của
 * tiêu đề từng ứng viên. Tiêu đề ứng viên không được lưu riêng ở Qdrant (mỗi chunk được embed
 * cùng tiêu đề, nên điểm tìm vector là điểm của "tiêu đề + nội dung"), vì vậy tiêu đề được
 * embed lúc truy vấn: input và mọi tiêu đề ứng viên (đã bỏ trùng) đi trong MỘT request batch
 * tới provider, tức thêm đúng một request embedding cho mỗi lần kiểm tra.
 *
 * Đây là gợi ý phụ cho model, nên lỗi được ghi log (chỉ mã lỗi, không có tiêu đề) rồi ném lại
 * để `checkDuplicates()` bỏ qua gợi ý này, không làm lời gọi thất bại.
 */
export function createTitleSimilarity(
  embed: Embedder,
  log?: (event: string, details: Record<string, unknown>) => void,
): NonNullable<DedupDependencies["titleSimilarities"]> {
  return async function titleSimilarities(input, candidates) {
    if (candidates.length === 0) return [];

    const titles = [...new Set(candidates.map((candidate) => candidate.title))];
    try {
      const vectors = await embed([input.title, ...titles]);
      if (vectors.length !== titles.length + 1) {
        throw new EmbeddingError(
          "BAD_RESPONSE",
          `Embedder trả số vector không khớp số tiêu đề (gửi ${titles.length + 1}, nhận ${vectors.length})`,
        );
      }
      const [inputVector, ...titleVectors] = vectors as [number[], ...number[][]];
      const byTitle = new Map(
        titles.map((title, index) => [title, cosine(inputVector, titleVectors[index]!)]),
      );
      return candidates.map((candidate) => byTitle.get(candidate.title)!);
    } catch (error) {
      log?.("title_similarity_unavailable", {
        cause: error instanceof EmbeddingError ? error.code : "UNKNOWN",
        candidates: candidates.length,
      });
      throw error;
    }
  };
}
