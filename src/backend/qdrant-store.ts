import {
  DEFAULT_MAX_SCROLL_POINTS,
  VectorStoreError,
  VectorStoreSet,
  assertChunkRange,
  assertIdeaId,
  assertSearchOptions,
  assertValidPoint,
  createInMemoryVectorStores,
  mergeHits,
  type IdeaChunkPayload,
  type IdeaHit,
  type ScrollResult,
  type SearchIdeasOptions,
  type StoredChunk,
  type VectorPoint,
  type VectorStore,
  type VectorStores,
} from "./vector-store.js";
import { isRecordType, type RecordType } from "./record-type.js";

/**
 * Qdrant qua REST. Chỉ dùng fetch để không thêm phụ thuộc và dễ test bằng
 * server giả.
 *
 * Một server Qdrant, ba collection riêng theo type (`<prefix>_ideas`,
 * `<prefix>_solutions`, `<prefix>_initiatives`). Mỗi `QdrantVectorStore` chỉ biết
 * đúng một collection nên không thể đọc, ghi hay xoá sang type khác. Mọi thao tác
 * xoá phải có điều kiện `ideaId` (đi qua `ideaFilter()`), nên không có đường xoá
 * "cả collection" trong code. Thông báo lỗi chỉ chứa mã HTTP, không chứa API key,
 * payload hay body phản hồi.
 *
 * Chạy local bằng Docker (README): REST ở cổng 6333 và không cần API key. Cổng 6334
 * là gRPC do Qdrant tự mở kèm, code này không dùng.
 */

/** Cấu hình kết nối + tên collection của từng type, đọc từ biến môi trường. */
export interface QdrantConfig {
  url: string;
  /** Tuỳ chọn: Qdrant local không cần. Bắt buộc (cùng https) với host không phải localhost. */
  apiKey: string;
  collectionPrefix: string;
  /** Collection riêng của từng type: `${collectionPrefix}_${type}`. */
  collections: Readonly<Record<RecordType, string>>;
  /** Số chiều vector của mỗi collection (phải khớp embedding model). */
  dimensions: number;
  timeoutMs: number;
}

/** Cấu hình của MỘT store: đúng một collection, đúng một type. */
export interface QdrantStoreConfig {
  url: string;
  apiKey: string;
  collection: string;
  recordType: RecordType;
  dimensions: number;
  timeoutMs: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Tối đa 200 để `${prefix}_${type}` vẫn nằm trong giới hạn 255 ký tự của Qdrant. */
const COLLECTION_PREFIX = /^[A-Za-z0-9_-]{1,200}$/;
const PAGE_SIZE = 256;
const UPSERT_BATCH_SIZE = 100;
/**
 * Các trường cần payload index vì truy vấn lọc theo chúng. Qdrant Cloud (strict
 * mode) từ chối lọc theo trường chưa có index (HTTP 400 "Index required but not
 * found"), kể cả lọc `range` của deleteChunksFrom trên chunkIndex. Luôn tạo index
 * cho mọi collection để Docker local và hosted hành xử như nhau.
 */
const INDEXED_FIELDS: ReadonlyArray<{ field: string; schema: "keyword" | "integer" }> = [
  { field: "ideaId", schema: "keyword" },
  { field: "chunkIndex", schema: "integer" },
];

/** Tên collection của một type: nơi DUY NHẤT ghép prefix với type. */
export function collectionNameFor(prefix: string, type: RecordType): string {
  return `${prefix}_${type}`;
}

export function loadQdrantConfig(
  env: NodeJS.ProcessEnv = process.env,
  dimensions: number,
): QdrantConfig {
  const rawUrl = (env.QDRANT_URL ?? "").trim().replace(/\/+$/, "");
  const collectionPrefix = env.QDRANT_COLLECTION_PREFIX ?? "";
  const apiKey = env.QDRANT_API_KEY ?? "";
  if (!rawUrl || !collectionPrefix) {
    // Môi trường cũ còn biến một-collection: nói rõ để khỏi mất công dò.
    const legacy = (env.QDRANT_COLLECTION ?? "").trim().length > 0;
    throw new VectorStoreError(
      "NOT_CONFIGURED",
      legacy && rawUrl
        ? "Thiếu QDRANT_COLLECTION_PREFIX (QDRANT_COLLECTION đã bị thay bằng QDRANT_COLLECTION_PREFIX: mỗi type một collection, xem .env.example)"
        : "Qdrant chưa được cấu hình (thiếu QDRANT_URL hoặc QDRANT_COLLECTION_PREFIX)",
    );
  }
  if (!COLLECTION_PREFIX.test(collectionPrefix)) {
    throw new VectorStoreError(
      "NOT_CONFIGURED",
      "QDRANT_COLLECTION_PREFIX chỉ gồm chữ, số, dấu gạch ngang và gạch dưới (tối đa 200 ký tự)",
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new VectorStoreError("NOT_CONFIGURED", "QDRANT_URL không hợp lệ", {
      cause: error,
    });
  }
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (!isLocal && url.protocol !== "https:") {
    throw new VectorStoreError(
      "NOT_CONFIGURED",
      "QDRANT_URL phải dùng https (chỉ localhost được dùng http)",
    );
  }
  if (!isLocal && !apiKey) {
    throw new VectorStoreError(
      "NOT_CONFIGURED",
      "Thiếu QDRANT_API_KEY cho Qdrant không chạy trên localhost",
    );
  }

  const timeoutMs = Number(env.QDRANT_TIMEOUT_MS);
  return {
    url: rawUrl,
    apiKey,
    collectionPrefix,
    collections: {
      ideas: collectionNameFor(collectionPrefix, "ideas"),
      solutions: collectionNameFor(collectionPrefix, "solutions"),
      initiatives: collectionNameFor(collectionPrefix, "initiatives"),
    },
    dimensions,
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000,
  };
}

/**
 * Bộ ba kho trong bộ nhớ dùng chung trong một tiến trình (theo số chiều) cho
 * QDRANT_MOCK_MODE: khi web chạy worker ngay trong tiến trình (QUEUE_MOCK_MODE=true),
 * sáng kiến được index qua webhook phải hiện ra ở tool check-duplicates. Nếu mỗi nơi
 * tự tạo một kho riêng thì tool luôn thấy kho rỗng và trả "không trùng" cho mọi thứ.
 * Vẫn là ba kho riêng theo type, giống mô hình 3 collection.
 */
const sharedMockStores = new Map<number, VectorStoreSet>();

function sharedMockStoreSet(dimensions: number): VectorStoreSet {
  let stores = sharedMockStores.get(dimensions);
  if (!stores) {
    stores = createInMemoryVectorStores(dimensions);
    sharedMockStores.set(dimensions, stores);
  }
  return stores;
}

/**
 * QDRANT_MOCK_MODE=true dùng store trong bộ nhớ (chung trong tiến trình, xem
 * sharedMockStoreSet; không chia sẻ được giữa web và worker chạy tiến trình riêng).
 * Biến không đặt nghĩa là dùng Qdrant thật (và báo NOT_CONFIGURED nếu thiếu cấu hình).
 */
export function createVectorStoresFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  dimensions: number,
): VectorStores {
  if (env.QDRANT_MOCK_MODE === "true") return sharedMockStoreSet(dimensions);

  const config = loadQdrantConfig(env, dimensions);
  const storeFor = (recordType: RecordType): VectorStore =>
    new QdrantVectorStore({
      url: config.url,
      apiKey: config.apiKey,
      collection: config.collections[recordType],
      recordType,
      dimensions: config.dimensions,
      timeoutMs: config.timeoutMs,
    });
  // Literal tường minh (không dựng từ RECORD_TYPES): thêm một type mà quên ở đây thì
  // không biên dịch được, thay vì chạy với thiếu collection.
  return new VectorStoreSet({
    ideas: storeFor("ideas"),
    solutions: storeFor("solutions"),
    initiatives: storeFor("initiatives"),
  });
}

type Condition =
  | { key: string; match: { value: string } }
  | { key: string; range: { gte: number } };

/** Nơi DUY NHẤT dựng filter xoá; luôn có điều kiện ideaId. */
function ideaFilter(ideaId: string, extra: Condition[] = []) {
  return {
    must: [{ key: "ideaId", match: { value: ideaId } }, ...extra],
  };
}

export class QdrantVectorStore implements VectorStore {
  readonly recordType: RecordType;
  private readonly config: QdrantStoreConfig;

  constructor(config: QdrantStoreConfig) {
    this.config = config;
    this.recordType = config.recordType;
  }

  async ensureCollection(): Promise<void> {
    let info = await this.request("GET", this.collectionPath(), undefined, [404]);
    if (info.status === 404) {
      // 409: tiến trình khác vừa tạo xong; bước đọc lại bên dưới sẽ kiểm tra.
      await this.request(
        "PUT",
        this.collectionPath(),
        { vectors: { size: this.config.dimensions, distance: "Cosine" } },
        [409],
      );
      info = await this.request("GET", this.collectionPath());
    }
    this.verifyCollection(info.result);

    for (const { field, schema } of INDEXED_FIELDS) {
      await this.request("PUT", `${this.collectionPath()}/index?wait=true`, {
        field_name: field,
        field_schema: schema,
      });
    }
  }

  async upsertChunks(points: VectorPoint[]): Promise<void> {
    for (const point of points) assertValidPoint(point, this.config.dimensions, this.recordType);
    for (let start = 0; start < points.length; start += UPSERT_BATCH_SIZE) {
      const batch = points.slice(start, start + UPSERT_BATCH_SIZE);
      await this.request("PUT", `${this.collectionPath()}/points?wait=true`, {
        points: batch.map(({ id, vector, payload }) => ({ id, vector, payload })),
      });
    }
  }

  /**
   * Top sáng kiến gần nhất bằng Query API nhóm theo `ideaId` (Qdrant >= 1.11): mỗi sáng
   * kiến chỉ xuất hiện một lần dù nhiều chunk cùng gần, nên `limit` đếm sáng kiến chứ
   * không đếm chunk. Mỗi vector truy vấn một request, chạy song song rồi gộp theo điểm
   * cao nhất. `excludeIdeaIds` đi vào `must_not` của chính truy vấn (không lọc sau), nên
   * sáng kiến bị loại không chiếm chỗ của `limit`. Chỉ lấy `embeddingModel` của payload
   * (không kéo nội dung chunk về); nội dung đầy đủ lấy ở bước `scrollIdeas`.
   */
  async searchIdeas(options: SearchIdeasOptions): Promise<IdeaHit[]> {
    assertSearchOptions(options, this.config.dimensions);
    const excluded = options.excludeIdeaIds ?? [];
    const filter =
      excluded.length > 0
        ? { must_not: [{ key: "ideaId", match: { any: excluded } }] }
        : undefined;

    const perVector = await Promise.all(
      options.vectors.map(async (vector) => {
        const { result } = await this.request(
          "POST",
          `${this.collectionPath()}/points/query/groups`,
          {
            query: vector,
            group_by: "ideaId",
            group_size: 1,
            limit: options.limit,
            with_payload: ["embeddingModel"],
            with_vector: false,
            ...(filter ? { filter } : {}),
          },
        );
        return parseGroups(result);
      }),
    );
    return mergeHits(perVector, options.limit);
  }

  async scrollIdeas(
    ideaIds: string[],
    options: { maxPoints?: number } = {},
  ): Promise<ScrollResult> {
    if (!ideaIds.every((id) => typeof id === "string" && id.length > 0)) {
      throw new VectorStoreError("BAD_REQUEST", "ideaId không được rỗng");
    }
    if (ideaIds.length === 0) return { points: [], truncated: false };
    return this.scrollPoints(options.maxPoints, {
      must: [{ key: "ideaId", match: { any: ideaIds } }],
    });
  }

  async scrollAll(options: { maxPoints?: number } = {}): Promise<ScrollResult> {
    return this.scrollPoints(options.maxPoints);
  }

  private async scrollPoints(
    maxPointsOption: number | undefined,
    filter?: Record<string, unknown>,
  ): Promise<ScrollResult> {
    const maxPoints = maxPointsOption ?? DEFAULT_MAX_SCROLL_POINTS;
    if (!Number.isInteger(maxPoints) || maxPoints < 1) {
      throw new VectorStoreError("BAD_REQUEST", "maxPoints phải là số nguyên dương");
    }

    const points: StoredChunk[] = [];
    let offset: unknown = undefined;
    for (;;) {
      const limit = Math.min(PAGE_SIZE, maxPoints - points.length);
      const { result } = await this.request(
        "POST",
        `${this.collectionPath()}/points/scroll`,
        {
          limit,
          with_payload: true,
          with_vector: false,
          ...(filter ? { filter } : {}),
          ...(offset !== undefined ? { offset } : {}),
        },
      );
      const page = parseScrollPage(result);
      points.push(...page.points);

      if (page.nextOffset === null) return { points, truncated: false };
      if (points.length >= maxPoints) return { points, truncated: true };
      if (page.points.length === 0) {
        throw new VectorStoreError(
          "BAD_RESPONSE",
          "Qdrant trả trang rỗng nhưng vẫn báo còn dữ liệu",
        );
      }
      offset = page.nextOffset;
    }
  }

  async deleteIdea(ideaId: string): Promise<void> {
    assertIdeaId(ideaId);
    await this.deleteByFilter(ideaFilter(ideaId));
  }

  async deleteChunksFrom(ideaId: string, fromChunkIndex: number): Promise<void> {
    assertChunkRange(ideaId, fromChunkIndex);
    await this.deleteByFilter(
      ideaFilter(ideaId, [{ key: "chunkIndex", range: { gte: fromChunkIndex } }]),
    );
  }

  private async deleteByFilter(filter: ReturnType<typeof ideaFilter>) {
    await this.request("POST", `${this.collectionPath()}/points/delete?wait=true`, {
      filter,
    });
  }

  private collectionPath(): string {
    return `/collections/${encodeURIComponent(this.config.collection)}`;
  }

  private verifyCollection(result: unknown): void {
    const vectors = dig(result, ["config", "params", "vectors"]);
    const size = isRecord(vectors) ? vectors.size : undefined;
    const distance = isRecord(vectors) ? vectors.distance : undefined;
    if (
      size !== this.config.dimensions ||
      typeof distance !== "string" ||
      distance.toLowerCase() !== "cosine"
    ) {
      throw new VectorStoreError(
        "COLLECTION_MISMATCH",
        `Collection "${this.config.collection}" hiện có không khớp cấu hình (cần vector đơn ${this.config.dimensions} chiều, cosine). Đổi embedding model thì phải dùng QDRANT_COLLECTION_PREFIX mới và reindex`,
      );
    }
  }

  private async request(
    method: "GET" | "PUT" | "POST",
    path: string,
    body?: unknown,
    tolerate: number[] = [],
  ): Promise<{ status: number; result: unknown }> {
    let response: Response;
    try {
      response = await fetch(`${this.config.url}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { "api-key": this.config.apiKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw transportError(error);
    }

    if (tolerate.includes(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      return { status: response.status, result: undefined };
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw statusError(response.status);
    }

    try {
      const json: unknown = await response.json();
      return { status: response.status, result: isRecord(json) ? json.result : undefined };
    } catch (error) {
      if (isTimeout(error)) throw transportError(error);
      throw new VectorStoreError(
        "BAD_RESPONSE",
        "Qdrant trả response không phải JSON hợp lệ",
        { cause: error },
      );
    }
  }
}

function parseScrollPage(result: unknown): { points: StoredChunk[]; nextOffset: unknown } {
  if (!isRecord(result) || !Array.isArray(result.points)) {
    throw new VectorStoreError("BAD_RESPONSE", "Qdrant trả scroll sai định dạng");
  }

  const points = result.points.map((raw: unknown): StoredChunk => {
    if (
      !isRecord(raw) ||
      (typeof raw.id !== "string" && typeof raw.id !== "number") ||
      !isRecord(raw.payload)
    ) {
      throw new VectorStoreError("BAD_RESPONSE", "Qdrant trả point sai định dạng");
    }
    return { id: String(raw.id), payload: toPayload(raw.payload) };
  });

  return { points, nextOffset: result.next_page_offset ?? null };
}

/**
 * Response của `points/query/groups`: `{ groups: [{ id: <ideaId>, hits: [{ score, payload }] }] }`,
 * đã xếp theo điểm giảm dần. `group_size: 1` nên mỗi nhóm có đúng hit gần nhất của sáng kiến.
 */
function parseGroups(result: unknown): IdeaHit[] {
  if (!isRecord(result) || !Array.isArray(result.groups)) {
    throw new VectorStoreError("BAD_RESPONSE", "Qdrant trả kết quả tìm kiếm sai định dạng");
  }
  return result.groups.map((group: unknown): IdeaHit => {
    const hit = isRecord(group) && Array.isArray(group.hits) ? group.hits[0] : undefined;
    if (
      !isRecord(group) ||
      typeof group.id !== "string" ||
      group.id.length === 0 ||
      !isRecord(hit) ||
      typeof hit.score !== "number" ||
      !Number.isFinite(hit.score) ||
      !isRecord(hit.payload) ||
      typeof hit.payload.embeddingModel !== "string"
    ) {
      throw new VectorStoreError("BAD_RESPONSE", "Qdrant trả một nhóm kết quả sai định dạng");
    }
    return { ideaId: group.id, score: hit.score, embeddingModel: hit.payload.embeddingModel };
  });
}

function toPayload(raw: Record<string, unknown>): IdeaChunkPayload {
  if (
    typeof raw.ideaId !== "string" ||
    !isRecordType(raw.type) ||
    typeof raw.title !== "string" ||
    typeof raw.content !== "string" ||
    !Number.isInteger(raw.chunkIndex) ||
    !Number.isInteger(raw.chunkCount) ||
    typeof raw.embeddingModel !== "string" ||
    typeof raw.indexedAt !== "string"
  ) {
    throw new VectorStoreError("BAD_RESPONSE", "Payload của point thiếu trường bắt buộc");
  }
  return {
    ideaId: raw.ideaId,
    type: raw.type,
    title: raw.title,
    chunkIndex: raw.chunkIndex as number,
    chunkCount: raw.chunkCount as number,
    content: raw.content,
    metadata: isRecord(raw.metadata) ? raw.metadata : {},
    embeddingModel: raw.embeddingModel,
    indexedAt: raw.indexedAt,
  };
}

function statusError(status: number): VectorStoreError {
  if (status === 401 || status === 403) {
    return new VectorStoreError("AUTH_ERROR", `Qdrant từ chối xác thực (HTTP ${status})`);
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new VectorStoreError("UPSTREAM_ERROR", `Qdrant tạm thời lỗi (HTTP ${status})`);
  }
  return new VectorStoreError("BAD_REQUEST", `Qdrant từ chối request (HTTP ${status})`);
}

function transportError(error: unknown): VectorStoreError {
  if (isTimeout(error)) {
    return new VectorStoreError("TIMEOUT", "Gọi Qdrant quá thời gian cho phép", {
      cause: error,
    });
  }
  return new VectorStoreError("NETWORK_ERROR", "Không thể kết nối tới Qdrant", {
    cause: error,
  });
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function dig(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
