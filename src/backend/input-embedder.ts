import { chunkText, DEFAULT_CHUNK_CHARS } from "./chunker.js";
import { EmbeddingError, embeddingText, type Embedder } from "./embeddings.js";
import type { DedupDependencies } from "./dedup.js";

/**
 * Bước 1 của luồng kiểm tra trùng: embed hồ sơ đầu vào thành các vector truy vấn.
 *
 * Nội dung được chia đoạn bằng ĐÚNG `chunkText` + kích thước đoạn của luồng index và mỗi
 * đoạn được embed cùng tiêu đề (`embeddingText`), nên vector truy vấn có cùng "khẩu độ"
 * với vector đã lưu. Một vector cho cả hồ sơ dài sẽ pha loãng ý tưởng cốt lõi; nhiều
 * vector (một cho mỗi đoạn) để bước tìm lấy điểm cao nhất giữa các cặp đoạn.
 *
 * Mọi đoạn đi trong MỘT request batch tới provider (embeddings.ts tự chia nếu quá
 * `batchSize`), nên một lần kiểm tra tốn một request embedding. `content` tối đa 20000
 * ký tự (schema) nên số đoạn có trần tự nhiên, không cần cắt thêm.
 *
 * Lỗi của embedder (`EmbeddingError`) được giữ nguyên để lớp trên đặt tên và phân loại.
 */
export function createInputEmbedder(
  embed: Embedder,
  options: { chunkChars?: number } = {},
): DedupDependencies["embedInput"] {
  const maxChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS;

  return async function embedInput(input) {
    const chunks = chunkText(input.content, { maxChars });
    if (chunks.length === 0) {
      // checkDuplicates() đã chặn content rỗng; tới đây nghĩa là caller bỏ qua bước kiểm tra đó.
      throw new EmbeddingError("INVALID_INPUT", "Hồ sơ đầu vào không có nội dung để embed");
    }
    const vectors = await embed(chunks.map((chunk) => embeddingText(input.title, chunk)));
    if (vectors.length !== chunks.length) {
      throw new EmbeddingError(
        "BAD_RESPONSE",
        `Embedder trả số vector không khớp số đoạn (gửi ${chunks.length}, nhận ${vectors.length})`,
      );
    }
    return vectors;
  };
}
