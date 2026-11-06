import { createHash } from "node:crypto";
import { RECORD_TYPES, RECORD_TYPES_LABEL, isRecordType, type RecordType } from "./record-type.js";

/**
 * Hợp đồng lưu trữ vector.
 *
 * Mô hình dữ liệu: MỘT collection cho MỖI type (ideas / solutions / initiatives,
 * xem record-type.ts) trên cùng một server Qdrant. Mỗi `VectorStore` gắn với đúng
 * một collection nên không có thao tác nào của nó chạm sang type khác; chọn store
 * theo type là việc của `VectorStores.forType()`. Hệ quả cần nhớ:
 * - Tách ở tầng lưu trữ, không phải lọc sau khi đọc: kiểm tra trùng của một type
 *   chỉ đọc collection của type đó, nên không thể thấy hay so khớp type khác.
 * - Từ 2026-11-04 không còn `datasetKey`: app không tách dữ liệu theo workspace hay
 *   tenant. Ai gọi được tool `check-duplicates` thì thấy mọi sáng kiến của type
 *   được hỏi, nên việc giới hạn người gọi làm ở tầng tool (kiểm claim đã xác thực
 *   của Core), không phải ở đây.
 * - Mỗi môi trường dùng một tiền tố collection riêng (QDRANT_COLLECTION_PREFIX).
 * - `ideaId` là khoá định danh một sáng kiến và phải duy nhất trong toàn VNAIP: gửi
 *   lại cùng `ideaId` CÙNG type nghĩa là cập nhật chính sáng kiến đó. Hệ quả của
 *   việc tách collection: gửi lại cùng `ideaId` với type KHÁC sẽ tạo bản thứ hai ở
 *   collection của type mới và KHÔNG xoá bản cũ ở collection của type cũ.
 * - Point ID suy ra từ (ideaId, chunkIndex) nên retry không tạo trùng. Hai
 *   collection độc lập nhau nên cùng point ID ở hai collection là hai point khác nhau.
 */

export type VectorStoreErrorCode =
  | "NOT_CONFIGURED"
  | "INVALID_TYPE"
  | "INVALID_POINT"
  | "COLLECTION_MISMATCH"
  | "AUTH_ERROR"
  | "BAD_REQUEST"
  | "UPSTREAM_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "BAD_RESPONSE";

const RETRYABLE_CODES: ReadonlySet<VectorStoreErrorCode> = new Set([
  "UPSTREAM_ERROR",
  "TIMEOUT",
  "NETWORK_ERROR",
]);

export class VectorStoreError extends Error {
  readonly code: VectorStoreErrorCode;
  readonly retryable: boolean;

  constructor(
    code: VectorStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.name = "VectorStoreError";
  }
}

export const DEFAULT_MAX_SCROLL_POINTS = 10000;

/** Payload của mỗi chunk. */
export interface IdeaChunkPayload {
  ideaId: string;
  /** Luôn bằng type của collection chứa point này (store từ chối ghi lệch). */
  type: RecordType;
  title: string;
  chunkIndex: number;
  chunkCount: number;
  content: string;
  metadata: Record<string, unknown>;
  /** Model đã tạo vector; đổi model thì phải reindex. */
  embeddingModel: string;
  indexedAt: string;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: IdeaChunkPayload;
}

export interface StoredChunk {
  id: string;
  payload: IdeaChunkPayload;
}

export interface ScrollResult {
  points: StoredChunk[];
  /** true nếu còn point chưa trả về vì chạm `maxPoints`. */
  truncated: boolean;
}

export interface SearchIdeasOptions {
  /**
   * Vector truy vấn, mỗi vector là một đoạn của input. Điểm của một sáng kiến là điểm
   * CAO NHẤT trong mọi cặp (đoạn input, chunk của sáng kiến): hồ sơ dài không bị pha
   * loãng thành một vector trung bình.
   */
  vectors: number[][];
  /** Số sáng kiến tối đa trả về (không phải số chunk). */
  limit: number;
  /** Sáng kiến bị loại ngay trong truy vấn, nên không chiếm chỗ của `limit`. */
  excludeIdeaIds?: string[];
}

/** Số chunk khớp tối đa được giữ cho mỗi sáng kiến (đưa vào `matchedChunks` của prompt chấm điểm). */
export const MAX_MATCHED_CHUNKS = 3;

/** Chunk gần nhất của một sáng kiến đối với MỘT vector truy vấn. */
export interface ChunkHit {
  ideaId: string;
  /** Cosine similarity của chunk này với vector truy vấn (-1..1). */
  score: number;
  /** Model đã tạo vector của chunk này (`IdeaChunkPayload.embeddingModel`). */
  embeddingModel: string;
  chunkIndex: number;
}

/** Một sáng kiến gần vector truy vấn, sau khi gộp kết quả của mọi vector truy vấn. */
export interface IdeaHit {
  ideaId: string;
  /** Cosine similarity của chunk gần nhất (-1..1). Chỉ để xếp hạng và log, không phải kết quả cuối. */
  score: number;
  /** Model đã tạo vector của chunk gần nhất (`IdeaChunkPayload.embeddingModel`). */
  embeddingModel: string;
  /**
   * Chỉ số các chunk của sáng kiến từng là chunk gần nhất của ít nhất một vector truy vấn,
   * xếp theo điểm khớp giảm dần, không trùng, tối đa `MAX_MATCHED_CHUNKS`. Phần đầu tiên là
   * chunk đã cho `score`.
   */
  chunkIndexes: number[];
}

/** Xếp hạng giảm dần theo điểm; bằng điểm thì theo ideaId để thứ tự xác định. */
export function compareHits(
  a: { ideaId: string; score: number },
  b: { ideaId: string; score: number },
): number {
  return b.score - a.score || (a.ideaId < b.ideaId ? -1 : a.ideaId > b.ideaId ? 1 : 0);
}

/**
 * Gộp kết quả của nhiều lần truy vấn (mỗi vector truy vấn một lần): mỗi sáng kiến giữ
 * điểm cao nhất, xếp hạng rồi cắt còn `limit`. Dùng chung cho mọi implementation.
 */
export function mergeHits(perVector: ChunkHit[][], limit: number): IdeaHit[] {
  const best = new Map<string, ChunkHit>();
  const chunkScores = new Map<string, Map<number, number>>();
  for (const hits of perVector) {
    for (const hit of hits) {
      const current = best.get(hit.ideaId);
      if (!current || hit.score > current.score) best.set(hit.ideaId, hit);

      let scores = chunkScores.get(hit.ideaId);
      if (!scores) chunkScores.set(hit.ideaId, (scores = new Map()));
      const known = scores.get(hit.chunkIndex);
      if (known === undefined || hit.score > known) scores.set(hit.chunkIndex, hit.score);
    }
  }

  return [...best.values()]
    .sort(compareHits)
    .slice(0, limit)
    .map((hit) => ({
      ideaId: hit.ideaId,
      score: hit.score,
      embeddingModel: hit.embeddingModel,
      chunkIndexes: [...chunkScores.get(hit.ideaId)!.entries()]
        // Bằng điểm thì chunk đứng trước, để thứ tự xác định giữa các lần gọi.
        .sort(([indexA, scoreA], [indexB, scoreB]) => scoreB - scoreA || indexA - indexB)
        .slice(0, MAX_MATCHED_CHUNKS)
        .map(([chunkIndex]) => chunkIndex),
    }));
}

/** Kiểm tham số của searchIdeas; dùng chung cho mọi implementation. */
export function assertSearchOptions(options: SearchIdeasOptions, dimensions: number): void {
  const { vectors, limit } = options;
  const valid =
    Array.isArray(vectors) &&
    vectors.length > 0 &&
    vectors.every(
      (vector) =>
        Array.isArray(vector) &&
        vector.length === dimensions &&
        vector.every((value) => Number.isFinite(value)),
    ) &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    (options.excludeIdeaIds ?? []).every((id) => typeof id === "string" && id.length > 0);
  if (!valid) {
    throw new VectorStoreError(
      "BAD_REQUEST",
      "Truy vấn vector không hợp lệ: cần ít nhất một vector đúng số chiều, limit là số nguyên dương và excludeIdeaIds là chuỗi không rỗng",
    );
  }
}

/** Một store = đúng MỘT collection = đúng MỘT type. Mọi thao tác chỉ chạm collection đó. */
export interface VectorStore {
  /** Type của collection mà store này đọc và ghi. */
  readonly recordType: RecordType;
  /** Tạo collection và payload index nếu chưa có; báo lỗi nếu cấu hình lệch. */
  ensureCollection(): Promise<void>;
  /**
   * Idempotent: cùng (ideaId, chunkIndex) thì ghi đè đúng point đó. Từ chối
   * (INVALID_POINT) point có `payload.type` khác `recordType` của store.
   */
  upsertChunks(points: VectorPoint[]): Promise<void>;
  /**
   * Tìm các sáng kiến gần nhất với vector truy vấn (cosine), mỗi sáng kiến một mục,
   * xếp hạng giảm dần. Chỉ tìm trong collection của type này. Không có sáng kiến nào
   * thì trả mảng rỗng.
   */
  searchIdeas(options: SearchIdeasOptions): Promise<IdeaHit[]>;
  /**
   * Lấy MỌI chunk của các sáng kiến đã cho (không có vector) để ghép lại nội dung đầy đủ
   * sau bước tìm. ideaId không có trong collection thì bị bỏ qua.
   */
  scrollIdeas(ideaIds: string[], options?: { maxPoints?: number }): Promise<ScrollResult>;
  /**
   * Lấy mọi chunk trong collection của type này (không có vector). Luồng kiểm tra trùng
   * không còn dùng (đã chuyển sang searchIdeas + scrollIdeas); giữ lại để kiểm tra và test.
   */
  scrollAll(options?: { maxPoints?: number }): Promise<ScrollResult>;
  deleteIdea(ideaId: string): Promise<void>;
  /**
   * Xoá các chunk có chunkIndex >= fromChunkIndex của một idea. Dùng sau khi
   * index lại một idea với ít chunk hơn lần trước, để không còn chunk thừa.
   */
  deleteChunksFrom(ideaId: string, fromChunkIndex: number): Promise<void>;
}

/** Chọn store theo type. Mọi đường ghi/đọc/xoá phải đi qua đây để vào đúng collection. */
export interface VectorStores {
  /**
   * Store của đúng collection cho `type`. Ném VectorStoreError(INVALID_TYPE, không
   * retry) nếu `type` không phải một trong RECORD_TYPES, trước khi làm bất cứ việc
   * gì khác. Nhận `string` vì type của job đọc từ hàng đợi chỉ là dữ liệu đã
   * serialize, không được tin theo kiểu của TypeScript.
   */
  forType(type: string): VectorStore;
}

export class VectorStoreSet implements VectorStores {
  private readonly stores: Readonly<Record<RecordType, VectorStore>>;

  constructor(stores: Readonly<Record<RecordType, VectorStore>>) {
    for (const type of RECORD_TYPES) {
      if (stores[type]?.recordType !== type) {
        // Lỗi lắp ráp của chính app, không phải dữ liệu: store gắn nhầm type sẽ ghi
        // sai collection một cách im lặng nên không được để chạy tiếp.
        throw new VectorStoreError(
          "NOT_CONFIGURED",
          `Store của type "${type}" bị thiếu hoặc gắn nhầm type`,
        );
      }
    }
    this.stores = stores;
  }

  forType(type: string): VectorStore {
    if (!isRecordType(type)) {
      throw new VectorStoreError("INVALID_TYPE", `type phải là một trong: ${RECORD_TYPES_LABEL}`);
    }
    return this.stores[type];
  }
}

/**
 * Bọc ensureCollection để mỗi type chỉ tạo/kiểm collection một lần (ở lần dùng đầu
 * tiên của type đó); lỗi thì lần sau thử lại. Qdrant chậm hay lỗi không làm tiến
 * trình khởi động chậm, và collection của type chưa có dữ liệu vẫn được tạo để lần
 * đọc đầu trả danh sách rỗng thay vì lỗi 404.
 */
export function lazyEnsureCollections(stores: VectorStores): (type: string) => Promise<void> {
  const ready = new Map<RecordType, Promise<void>>();
  return (type) => {
    const store = stores.forType(type);
    let pending = ready.get(store.recordType);
    if (!pending) {
      pending = store.ensureCollection().catch((error) => {
        ready.delete(store.recordType);
        throw error;
      });
      ready.set(store.recordType, pending);
    }
    return pending;
  };
}

// Namespace cố định cho UUID v5 của app này. Đổi giá trị này sẽ đổi mọi point ID.
const POINT_ID_NAMESPACE = Buffer.from("5b0e9d2c7a1f4e6b9c3d8a2f1e4b7c60", "hex");

/**
 * UUID v5 xác định từ (ideaId, chunkIndex). Qdrant chỉ nhận số nguyên không dấu
 * hoặc UUID làm point ID. Phần cuối của tên luôn là số nguyên nên hai cặp giá
 * trị khác nhau không thể sinh cùng chuỗi tên, kể cả khi ideaId chứa dấu ":".
 */
export function pointId(ideaId: string, chunkIndex: number): string {
  const bytes = Buffer.from(
    createHash("sha1")
      .update(POINT_ID_NAMESPACE)
      .update(`${ideaId}:${chunkIndex}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * Kiểm point trước khi ghi; dùng chung cho mọi implementation. `recordType` là type
 * của collection định ghi vào: point mang type khác bị từ chối, nên không thể ghi
 * nhầm collection kể cả khi caller chọn sai store.
 */
export function assertValidPoint(
  point: VectorPoint,
  dimensions: number,
  recordType: RecordType,
): void {
  const { payload } = point;
  const valid =
    typeof payload === "object" &&
    payload !== null &&
    payload.type === recordType &&
    typeof payload.ideaId === "string" &&
    payload.ideaId.length > 0 &&
    Number.isInteger(payload.chunkIndex) &&
    payload.chunkIndex >= 0 &&
    Number.isInteger(payload.chunkCount) &&
    payload.chunkCount > payload.chunkIndex &&
    Array.isArray(point.vector) &&
    point.vector.length === dimensions &&
    point.vector.every((value) => Number.isFinite(value)) &&
    point.id === pointId(payload.ideaId, payload.chunkIndex);

  if (!valid) {
    throw new VectorStoreError(
      "INVALID_POINT",
      "Point không hợp lệ: type không khớp collection, thiếu ideaId hoặc chunk sai, sai số chiều vector, hoặc id không khớp pointId()",
    );
  }
}

/** Store trong bộ nhớ cho test và QDRANT_MOCK_MODE: một đối tượng = một "collection" = một type. */
export class InMemoryVectorStore implements VectorStore {
  readonly recordType: RecordType;
  private readonly points = new Map<string, VectorPoint>();
  private readonly dimensions: number;

  constructor(dimensions: number, recordType: RecordType) {
    this.dimensions = dimensions;
    this.recordType = recordType;
  }

  async ensureCollection(): Promise<void> {}

  async upsertChunks(points: VectorPoint[]): Promise<void> {
    for (const point of points) assertValidPoint(point, this.dimensions, this.recordType);
    for (const point of points) {
      this.points.set(point.id, structuredClone(point));
    }
  }

  async searchIdeas(options: SearchIdeasOptions): Promise<IdeaHit[]> {
    assertSearchOptions(options, this.dimensions);
    const excluded = new Set(options.excludeIdeaIds ?? []);
    const candidates = [...this.points.values()].filter(
      (point) => !excluded.has(point.payload.ideaId),
    );

    const perVector = options.vectors.map((query) => {
      const best = new Map<string, ChunkHit>();
      for (const point of candidates) {
        const score = cosine(query, point.vector);
        const current = best.get(point.payload.ideaId);
        if (!current || score > current.score) {
          best.set(point.payload.ideaId, {
            ideaId: point.payload.ideaId,
            score,
            embeddingModel: point.payload.embeddingModel,
            chunkIndex: point.payload.chunkIndex,
          });
        }
      }
      return [...best.values()].sort(compareHits).slice(0, options.limit);
    });
    return mergeHits(perVector, options.limit);
  }

  async scrollIdeas(
    ideaIds: string[],
    options: { maxPoints?: number } = {},
  ): Promise<ScrollResult> {
    const wanted = new Set(ideaIds);
    return this.scroll(options.maxPoints, (point) => wanted.has(point.payload.ideaId));
  }

  async scrollAll(options: { maxPoints?: number } = {}): Promise<ScrollResult> {
    return this.scroll(options.maxPoints, () => true);
  }

  private scroll(
    maxPointsOption: number | undefined,
    keep: (point: VectorPoint) => boolean,
  ): ScrollResult {
    const maxPoints = maxPointsOption ?? DEFAULT_MAX_SCROLL_POINTS;
    const sorted = [...this.points.values()]
      .filter(keep)
      .sort(
        (a, b) =>
          a.payload.ideaId.localeCompare(b.payload.ideaId) ||
          a.payload.chunkIndex - b.payload.chunkIndex,
      );
    return {
      points: sorted
        .slice(0, maxPoints)
        .map((point) => ({ id: point.id, payload: structuredClone(point.payload) })),
      truncated: sorted.length > maxPoints,
    };
  }

  async deleteIdea(ideaId: string): Promise<void> {
    assertIdeaId(ideaId);
    for (const [id, point] of this.points) {
      if (point.payload.ideaId === ideaId) this.points.delete(id);
    }
  }

  async deleteChunksFrom(ideaId: string, fromChunkIndex: number): Promise<void> {
    assertChunkRange(ideaId, fromChunkIndex);
    for (const [id, point] of this.points) {
      if (point.payload.ideaId === ideaId && point.payload.chunkIndex >= fromChunkIndex) {
        this.points.delete(id);
      }
    }
  }
}

/** Cosine similarity như distance "Cosine" của Qdrant; vector không (norm 0) cho 0 thay vì NaN. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
}

/** Bộ ba store trong bộ nhớ, mỗi type một store riêng, giống mô hình 3 collection của Qdrant. */
export function createInMemoryVectorStores(dimensions: number): VectorStoreSet {
  return new VectorStoreSet({
    ideas: new InMemoryVectorStore(dimensions, "ideas"),
    solutions: new InMemoryVectorStore(dimensions, "solutions"),
    initiatives: new InMemoryVectorStore(dimensions, "initiatives"),
  });
}

/** Kiểm ideaId của thao tác xoá; dùng chung cho mọi implementation. */
export function assertIdeaId(ideaId: string): void {
  if (typeof ideaId !== "string" || ideaId.length === 0) {
    throw new VectorStoreError("INVALID_POINT", "ideaId không được rỗng");
  }
}

/** Kiểm tham số của deleteChunksFrom; dùng chung cho mọi implementation. */
export function assertChunkRange(ideaId: string, fromChunkIndex: number): void {
  if (
    typeof ideaId !== "string" ||
    ideaId.length === 0 ||
    !Number.isInteger(fromChunkIndex) ||
    fromChunkIndex < 0
  ) {
    throw new VectorStoreError(
      "INVALID_POINT",
      "ideaId không được rỗng và chunkIndex phải là số nguyên không âm",
    );
  }
}
