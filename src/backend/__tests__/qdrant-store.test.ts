import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QdrantVectorStore,
  collectionNameFor,
  createVectorStoresFromEnv,
  loadQdrantConfig,
  type QdrantStoreConfig,
} from "../qdrant-store.js";
import {
  InMemoryVectorStore,
  VectorStoreError,
  pointId,
  type VectorPoint,
} from "../vector-store.js";
import { RECORD_TYPES, type RecordType } from "../record-type.js";
import { startFakeServer, type FakeResponse, type RecordedRequest } from "./helpers/fake-http-server.js";

const API_KEY = "qdrant-test-secret-key";
const DIMS = 3;

/** Cấu hình của MỘT store: mặc định là collection của type "solutions". */
function configFor(origin: string, overrides: Partial<QdrantStoreConfig> = {}): QdrantStoreConfig {
  return {
    url: origin,
    apiKey: API_KEY,
    collection: "vnaip_dedup_test",
    recordType: "solutions",
    dimensions: DIMS,
    timeoutMs: 2000,
    ...overrides,
  };
}

const collectionInfo = (size: number, distance = "Cosine") => ({
  status: 200,
  json: { result: { config: { params: { vectors: { size, distance } } } } },
});

function makePoint(ideaId = "GP-1", chunkIndex = 0, type: RecordType = "solutions"): VectorPoint {
  return {
    id: pointId(ideaId, chunkIndex),
    vector: [1, 0, 0],
    payload: {
      ideaId,
      type,
      title: "Tiêu đề",
      chunkIndex,
      chunkCount: 1,
      content: "Nội dung",
      metadata: { owner: "x" },
      embeddingModel: "openai/text-embedding-3-small",
      indexedAt: "2026-11-04T00:00:00.000Z",
    },
  };
}

const storedPayload = (ideaId = "GP-1", chunkIndex = 0) => makePoint(ideaId, chunkIndex).payload;

test("ensureCollection tạo collection khi chưa có, rồi tạo payload index", async () => {
  let created = false;
  const server = await startFakeServer((request: RecordedRequest): FakeResponse => {
    if (request.method === "GET") return created ? collectionInfo(DIMS) : { status: 404 };
    if (request.method === "PUT" && request.url === "/collections/vnaip_dedup_test") {
      created = true;
    }
    return { status: 200, json: { result: true } };
  });
  try {
    await new QdrantVectorStore(configFor(server.origin)).ensureCollection();

    const create = server.requests.find((request) => request.method === "PUT" && !request.url.includes("/index"));
    assert.deepEqual(create!.body, { vectors: { size: DIMS, distance: "Cosine" } });
    assert.equal(create!.headers["api-key"], API_KEY);

    const indexes = server.requests.filter((request) => request.url.includes("/index"));
    assert.deepEqual(
      indexes.map((request) => request.body),
      [
        { field_name: "ideaId", field_schema: "keyword" },
        // deleteChunksFrom lọc range trên chunkIndex; Qdrant Cloud đòi có index.
        { field_name: "chunkIndex", field_schema: "integer" },
      ],
    );
  } finally {
    await server.close();
  }
});

test("ensureCollection không tạo lại collection đã có đúng cấu hình", async () => {
  const server = await startFakeServer((request) =>
    request.method === "GET" ? collectionInfo(DIMS) : { status: 200, json: { result: true } },
  );
  try {
    await new QdrantVectorStore(configFor(server.origin)).ensureCollection();
    assert.equal(
      server.requests.some((request) => request.method === "PUT" && request.url === "/collections/vnaip_dedup_test"),
      false,
    );
  } finally {
    await server.close();
  }
});

test("ensureCollection báo COLLECTION_MISMATCH khi sai số chiều hoặc sai khoảng cách", async () => {
  for (const info of [collectionInfo(1536), collectionInfo(DIMS, "Dot")]) {
    const server = await startFakeServer(() => info);
    try {
      await assert.rejects(
        () => new QdrantVectorStore(configFor(server.origin)).ensureCollection(),
        (error: unknown) => error instanceof VectorStoreError && error.code === "COLLECTION_MISMATCH",
      );
    } finally {
      await server.close();
    }
  }
});

test("upsertChunks gửi đúng points và chia lô 100", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: { result: { status: "completed" } } }));
  try {
    const store = new QdrantVectorStore(configFor(server.origin));
    const points = Array.from({ length: 250 }, (_, i) => makePoint(`GP-${i}`));
    await store.upsertChunks(points);

    assert.equal(server.requests.length, 3);
    assert.deepEqual(server.requests.map((request) => request.body.points.length), [100, 100, 50]);
    assert.equal(server.requests[0]!.method, "PUT");
    assert.equal(server.requests[0]!.url, "/collections/vnaip_dedup_test/points?wait=true");
    assert.deepEqual(server.requests[0]!.body.points[0], {
      id: points[0]!.id,
      vector: points[0]!.vector,
      payload: points[0]!.payload,
    });
  } finally {
    await server.close();
  }
});

test("upsertChunks từ chối point sai trước khi gọi mạng", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: { result: true } }));
  try {
    const store = new QdrantVectorStore(configFor(server.origin));
    await assert.rejects(
      () => store.upsertChunks([{ ...makePoint(), vector: [1] }]),
      (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_POINT",
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("scrollAll không gửi filter và phân trang đến hết", async () => {
  const pages = [
    { points: [{ id: "p1", payload: storedPayload("GP-1") }], next_page_offset: "p2" },
    { points: [{ id: "p2", payload: storedPayload("GP-2") }], next_page_offset: null },
  ];
  const server = await startFakeServer((_request, index) => ({ status: 200, json: { result: pages[index] } }));
  try {
    const result = await new QdrantVectorStore(configFor(server.origin)).scrollAll();

    assert.deepEqual(result.points.map((point) => point.payload.ideaId), ["GP-1", "GP-2"]);
    assert.equal(result.truncated, false);
    for (const request of server.requests) {
      assert.equal(request.url, "/collections/vnaip_dedup_test/points/scroll");
      assert.equal("filter" in request.body, false);
      assert.equal(request.body.with_vector, false);
    }
    assert.equal(server.requests[0]!.body.offset, undefined);
    assert.equal(server.requests[1]!.body.offset, "p2");
  } finally {
    await server.close();
  }
});

test("scrollAll báo truncated khi chạm maxPoints mà vẫn còn dữ liệu", async () => {
  const server = await startFakeServer(() => ({
    status: 200,
    json: { result: { points: [{ id: "p1", payload: storedPayload() }], next_page_offset: "p2" } },
  }));
  try {
    const result = await new QdrantVectorStore(configFor(server.origin)).scrollAll({ maxPoints: 1 });
    assert.equal(result.points.length, 1);
    assert.equal(result.truncated, true);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]!.body.limit, 1);
  } finally {
    await server.close();
  }
});

test("scrollAll từ chối point thiếu trường bắt buộc trong payload", async () => {
  const { title: _omitted, ...incomplete } = storedPayload();
  const server = await startFakeServer(() => ({
    status: 200,
    json: { result: { points: [{ id: "p1", payload: incomplete }], next_page_offset: null } },
  }));
  try {
    await assert.rejects(
      () => new QdrantVectorStore(configFor(server.origin)).scrollAll(),
      (error: unknown) => error instanceof VectorStoreError && error.code === "BAD_RESPONSE",
    );
  } finally {
    await server.close();
  }
});

test("scrollAll từ chối trang rỗng nhưng còn offset (tránh lặp vô hạn)", async () => {
  const server = await startFakeServer(() => ({
    status: 200,
    json: { result: { points: [], next_page_offset: "p9" } },
  }));
  try {
    await assert.rejects(
      () => new QdrantVectorStore(configFor(server.origin)).scrollAll(),
      (error: unknown) => error instanceof VectorStoreError && error.code === "BAD_RESPONSE",
    );
  } finally {
    await server.close();
  }
});

test("deleteIdea luôn gửi filter có ideaId (không có đường xoá cả collection)", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: { result: { status: "completed" } } }));
  try {
    const store = new QdrantVectorStore(configFor(server.origin));
    await store.deleteIdea("GP-1");

    assert.equal(server.requests[0]!.url, "/collections/vnaip_dedup_test/points/delete?wait=true");
    assert.deepEqual(server.requests[0]!.body.filter, {
      must: [{ key: "ideaId", match: { value: "GP-1" } }],
    });
    await assert.rejects(
      () => store.deleteIdea(""),
      (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_POINT",
    );
  } finally {
    await server.close();
  }
});

test("deleteChunksFrom gửi filter có ideaId và chunkIndex >= chỉ số", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: { result: { status: "completed" } } }));
  try {
    const store = new QdrantVectorStore(configFor(server.origin));
    await store.deleteChunksFrom("GP-1", 3);

    assert.equal(server.requests[0]!.url, "/collections/vnaip_dedup_test/points/delete?wait=true");
    assert.deepEqual(server.requests[0]!.body.filter, {
      must: [
        { key: "ideaId", match: { value: "GP-1" } },
        { key: "chunkIndex", range: { gte: 3 } },
      ],
    });
    await assert.rejects(
      () => store.deleteChunksFrom("GP-1", -1),
      (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_POINT",
    );
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("map lỗi HTTP, timeout, mất kết nối và không lộ API key hay payload", async () => {
  const cases: Array<[number, string, boolean]> = [
    [401, "AUTH_ERROR", false],
    [400, "BAD_REQUEST", false],
    [429, "UPSTREAM_ERROR", true],
    [503, "UPSTREAM_ERROR", true],
  ];
  for (const [status, code, retryable] of cases) {
    const server = await startFakeServer(() => ({
      status,
      json: { status: { error: `echo ${API_KEY} nội dung nhạy cảm` } },
    }));
    try {
      await assert.rejects(
        () => new QdrantVectorStore(configFor(server.origin)).scrollAll(),
        (error: unknown) => {
          assert.ok(error instanceof VectorStoreError);
          assert.equal(error.code, code);
          assert.equal(error.retryable, retryable);
          assert.equal(error.message.includes(API_KEY), false);
          assert.equal(error.message.includes("nhạy cảm"), false);
          return true;
        },
      );
    } finally {
      await server.close();
    }
  }

  const slow = await startFakeServer(() => ({ status: 200, json: { result: {} }, delayMs: 300 }));
  try {
    await assert.rejects(
      () => new QdrantVectorStore(configFor(slow.origin, { timeoutMs: 50 })).scrollAll(),
      (error: unknown) => error instanceof VectorStoreError && error.code === "TIMEOUT" && error.retryable,
    );
  } finally {
    await slow.close();
  }

  const closed = await startFakeServer(() => ({ status: 200 }));
  const deadOrigin = closed.origin;
  await closed.close();
  await assert.rejects(
    () => new QdrantVectorStore(configFor(deadOrigin)).scrollAll(),
    (error: unknown) => error instanceof VectorStoreError && error.code === "NETWORK_ERROR" && error.retryable,
  );
});

test("loadQdrantConfig kiểm tra URL, tiền tố collection và API key", () => {
  const good = { QDRANT_URL: "https://x.cloud.qdrant.io:6333/", QDRANT_API_KEY: "k", QDRANT_COLLECTION_PREFIX: "vnaip_dedup_stg" };
  assert.equal(loadQdrantConfig(good, DIMS).url, "https://x.cloud.qdrant.io:6333");
  // Qdrant local bằng Docker: http + localhost, không cần API key.
  const local = loadQdrantConfig({ QDRANT_URL: "http://localhost:6333", QDRANT_COLLECTION_PREFIX: "c" }, DIMS);
  assert.equal(local.apiKey, "");
  assert.equal(loadQdrantConfig({ QDRANT_URL: "http://127.0.0.1:6333", QDRANT_COLLECTION_PREFIX: "c" }, DIMS).apiKey, "");

  const bad = [
    {},
    { ...good, QDRANT_COLLECTION_PREFIX: "" },
    { ...good, QDRANT_COLLECTION_PREFIX: "../etc" },
    { ...good, QDRANT_COLLECTION_PREFIX: "có dấu" },
    { ...good, QDRANT_COLLECTION_PREFIX: "a".repeat(201) },
    { ...good, QDRANT_URL: "khong-phai-url" },
    { ...good, QDRANT_URL: "http://qdrant.example.com:6333" },
    { ...good, QDRANT_API_KEY: "" },
  ];
  for (const env of bad) {
    assert.throws(
      () => loadQdrantConfig(env, DIMS),
      (error: unknown) => error instanceof VectorStoreError && error.code === "NOT_CONFIGURED",
    );
  }
});

test("loadQdrantConfig: mỗi type một collection tên `<prefix>_<type>`, khác nhau từng đôi một", () => {
  const { collections } = loadQdrantConfig(
    { QDRANT_URL: "http://localhost:6333", QDRANT_COLLECTION_PREFIX: "vnaip_dedup_dev" },
    DIMS,
  );
  assert.deepEqual(collections, {
    ideas: "vnaip_dedup_dev_ideas",
    solutions: "vnaip_dedup_dev_solutions",
    initiatives: "vnaip_dedup_dev_initiatives",
  });
  assert.equal(new Set(Object.values(collections)).size, RECORD_TYPES.length);
  for (const type of RECORD_TYPES) assert.equal(collections[type], collectionNameFor("vnaip_dedup_dev", type));
  // 200 ký tự prefix + "_initiatives" vẫn nằm trong giới hạn 255 của Qdrant.
  const longest = loadQdrantConfig({ QDRANT_URL: "http://localhost:6333", QDRANT_COLLECTION_PREFIX: "a".repeat(200) }, DIMS);
  assert.ok(Object.values(longest.collections).every((name) => name.length <= 255));
});

test("loadQdrantConfig: còn QDRANT_COLLECTION của bản một-collection thì báo rõ biến đã bị thay", () => {
  assert.throws(
    () => loadQdrantConfig({ QDRANT_URL: "http://localhost:6333", QDRANT_COLLECTION: "vnaip_dedup_stg" }, DIMS),
    (error: unknown) =>
      error instanceof VectorStoreError &&
      error.code === "NOT_CONFIGURED" &&
      error.message.includes("QDRANT_COLLECTION_PREFIX") &&
      !error.message.includes("vnaip_dedup_stg"),
  );
  // QDRANT_COLLECTION cũ KHÔNG được dùng thay prefix, kể cả khi hợp lệ.
  assert.throws(() => loadQdrantConfig({ QDRANT_URL: "http://localhost:6333", QDRANT_COLLECTION: "ok" }, DIMS));
});

/** Qdrant giả trả lời mọi request thành công; mỗi test tự kiểm tra các URL đã được gọi. */
async function startOkQdrant() {
  return startFakeServer((request): FakeResponse => {
    if (request.url.endsWith("/points/scroll")) {
      return { status: 200, json: { result: { points: [], next_page_offset: null } } };
    }
    if (request.method === "GET") return collectionInfo(DIMS);
    return { status: 200, json: { result: { status: "completed" } } };
  });
}

const collectionOf = (url: string) => url.split("/")[2];

test("createVectorStoresFromEnv: ghi, đọc, tạo index và xoá của mỗi type chỉ gọi đúng collection của type đó", async () => {
  for (const type of RECORD_TYPES) {
    const server = await startOkQdrant();
    try {
      const stores = createVectorStoresFromEnv(
        { QDRANT_URL: server.origin, QDRANT_COLLECTION_PREFIX: "vnaip_dedup_test" },
        DIMS,
      );
      const store = stores.forType(type);
      assert.equal(store.recordType, type);

      await store.ensureCollection();
      await store.upsertChunks([makePoint("GP-1", 0, type)]);
      await store.scrollAll();
      await store.deleteChunksFrom("GP-1", 1);
      await store.deleteIdea("GP-1");

      const hit = new Set(server.requests.map((request) => collectionOf(request.url)));
      assert.deepEqual([...hit], [`vnaip_dedup_test_${type}`], `type ${type} chỉ được chạm collection của nó`);
      assert.ok(server.requests.length >= 7, "phải thực sự gọi mạng cho cả năm thao tác");
    } finally {
      await server.close();
    }
  }
});

test("store của một type không ghi được point của type khác và không gọi mạng", async () => {
  const server = await startOkQdrant();
  try {
    const stores = createVectorStoresFromEnv(
      { QDRANT_URL: server.origin, QDRANT_COLLECTION_PREFIX: "vnaip_dedup_test" },
      DIMS,
    );
    for (const storeType of RECORD_TYPES) {
      for (const pointType of RECORD_TYPES.filter((type) => type !== storeType)) {
        await assert.rejects(
          () => stores.forType(storeType).upsertChunks([makePoint("GP-1", 0, pointType)]),
          (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_POINT",
        );
      }
    }
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("forType từ chối type lạ trước khi gọi mạng (cả type cũ \"solution\")", async () => {
  const server = await startOkQdrant();
  try {
    const stores = createVectorStoresFromEnv(
      { QDRANT_URL: server.origin, QDRANT_COLLECTION_PREFIX: "vnaip_dedup_test" },
      DIMS,
    );
    for (const bogus of ["solution", "idea", "project", "other", ""]) {
      assert.throws(
        () => stores.forType(bogus),
        (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_TYPE" && !error.retryable,
      );
    }
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("scrollAll từ chối point có type ngoài ideas/solutions/initiatives (kể cả \"solution\" cũ)", async () => {
  for (const bogus of ["solution", "idea", "", 7]) {
    const server = await startFakeServer(() => ({
      status: 200,
      json: { result: { points: [{ id: "p1", payload: { ...storedPayload(), type: bogus } }], next_page_offset: null } },
    }));
    try {
      await assert.rejects(
        () => new QdrantVectorStore(configFor(server.origin)).scrollAll(),
        (error: unknown) => error instanceof VectorStoreError && error.code === "BAD_RESPONSE",
      );
    } finally {
      await server.close();
    }
  }
});

test("QDRANT_MOCK_MODE=true trả CÙNG bộ ba kho trong tiến trình cho cùng số chiều, bộ khác cho số chiều khác", async () => {
  const a = createVectorStoresFromEnv({ QDRANT_MOCK_MODE: "true" }, DIMS);
  const b = createVectorStoresFromEnv({ QDRANT_MOCK_MODE: "true" }, DIMS);
  const other = createVectorStoresFromEnv({ QDRANT_MOCK_MODE: "true" }, DIMS + 1);

  assert.equal(a, b, "worker inline và tool phải thấy cùng dữ liệu");
  assert.notEqual(a, other);
  for (const type of RECORD_TYPES) {
    assert.equal(a.forType(type), b.forType(type));
    assert.notEqual(a.forType(type), other.forType(type));
  }
});

test("QDRANT_MOCK_MODE=true dùng kho trong bộ nhớ, mỗi type một kho riêng; không đặt thì cần cấu hình thật", () => {
  const stores = createVectorStoresFromEnv({ QDRANT_MOCK_MODE: "true" }, DIMS);
  for (const type of RECORD_TYPES) {
    assert.ok(stores.forType(type) instanceof InMemoryVectorStore);
    assert.equal(stores.forType(type).recordType, type);
  }
  assert.equal(new Set(RECORD_TYPES.map((type) => stores.forType(type))).size, RECORD_TYPES.length);
  assert.throws(
    () => createVectorStoresFromEnv({}, DIMS),
    (error: unknown) => error instanceof VectorStoreError && error.code === "NOT_CONFIGURED",
  );
});

// --- Tìm sáng kiến gần nhất (hướng B) ---

const group = (ideaId: string, score: number, embeddingModel = "gemini-embedding-001") => ({
  id: ideaId,
  hits: [{ id: pointId(ideaId, 0), version: 3, score, payload: { embeddingModel } }],
});

test("searchIdeas gọi query/groups nhóm theo ideaId, chỉ kéo embeddingModel, và không có filter khi không loại id", async () => {
  const server = await startFakeServer(() => ({
    status: 200,
    json: { result: { groups: [group("GP-1", 0.93), group("GP-2", 0.71)] } },
  }));
  try {
    const hits = await new QdrantVectorStore(configFor(server.origin)).searchIdeas({
      vectors: [[1, 0, 0]],
      limit: 20,
    });

    assert.deepEqual(hits, [
      { ideaId: "GP-1", score: 0.93, embeddingModel: "gemini-embedding-001" },
      { ideaId: "GP-2", score: 0.71, embeddingModel: "gemini-embedding-001" },
    ]);
    assert.equal(server.requests.length, 1);
    const request = server.requests[0]!;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/collections/vnaip_dedup_test/points/query/groups");
    assert.equal(request.headers["api-key"], API_KEY);
    assert.deepEqual(request.body, {
      query: [1, 0, 0],
      group_by: "ideaId",
      group_size: 1,
      limit: 20,
      with_payload: ["embeddingModel"],
      with_vector: false,
    });
  } finally {
    await server.close();
  }
});

test("searchIdeas đưa excludeIdeaIds vào must_not của chính truy vấn", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: { result: { groups: [] } } }));
  try {
    await new QdrantVectorStore(configFor(server.origin)).searchIdeas({
      vectors: [[1, 0, 0]],
      limit: 5,
      excludeIdeaIds: ["GP-1", "GP-9"],
    });

    assert.deepEqual(server.requests[0]!.body.filter, {
      must_not: [{ key: "ideaId", match: { any: ["GP-1", "GP-9"] } }],
    });
  } finally {
    await server.close();
  }
});

test("searchIdeas với nhiều vector: mỗi vector một request, gộp theo điểm cao nhất rồi cắt còn limit", async () => {
  const byQuery: Record<string, unknown[]> = {
    "1,0,0": [group("A", 0.9), group("B", 0.4)],
    "0,1,0": [group("B", 0.95), group("C", 0.5)],
  };
  const server = await startFakeServer((request) => ({
    status: 200,
    json: { result: { groups: byQuery[request.body.query.join(",")] } },
  }));
  try {
    const hits = await new QdrantVectorStore(configFor(server.origin)).searchIdeas({
      vectors: [[1, 0, 0], [0, 1, 0]],
      limit: 2,
    });

    assert.equal(server.requests.length, 2);
    assert.deepEqual(hits.map((h) => [h.ideaId, h.score]), [["B", 0.95], ["A", 0.9]]);
  } finally {
    await server.close();
  }
});

test("searchIdeas trên collection rỗng trả mảng rỗng", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: { result: { groups: [] } } }));
  try {
    assert.deepEqual(
      await new QdrantVectorStore(configFor(server.origin)).searchIdeas({ vectors: [[1, 0, 0]], limit: 5 }),
      [],
    );
  } finally {
    await server.close();
  }
});

test("searchIdeas từ chối response sai định dạng (BAD_RESPONSE), không coi là kết quả rỗng", async () => {
  const malformed: unknown[] = [
    { result: {} },
    { result: { groups: "x" } },
    { result: { groups: [{ id: 7, hits: [{ score: 1, payload: { embeddingModel: "m" } }] }] } },
    { result: { groups: [{ id: "A", hits: [] }] } },
    { result: { groups: [{ id: "A", hits: [{ score: "cao", payload: { embeddingModel: "m" } }] }] } },
    { result: { groups: [{ id: "A", hits: [{ score: 1, payload: {} }] }] } },
  ];
  for (const json of malformed) {
    const server = await startFakeServer(() => ({ status: 200, json }));
    try {
      await assert.rejects(
        () => new QdrantVectorStore(configFor(server.origin)).searchIdeas({ vectors: [[1, 0, 0]], limit: 5 }),
        (error: unknown) => error instanceof VectorStoreError && error.code === "BAD_RESPONSE",
        JSON.stringify(json),
      );
    } finally {
      await server.close();
    }
  }
});

test("searchIdeas phân loại lỗi HTTP như các thao tác khác và không lộ API key", async () => {
  const cases: Array<[number, string, boolean]> = [
    [401, "AUTH_ERROR", false],
    [500, "UPSTREAM_ERROR", true],
  ];
  for (const [status, code, retryable] of cases) {
    const server = await startFakeServer(() => ({ status }));
    try {
      await assert.rejects(
        () => new QdrantVectorStore(configFor(server.origin)).searchIdeas({ vectors: [[1, 0, 0]], limit: 5 }),
        (error: unknown) => {
          assert.ok(error instanceof VectorStoreError);
          assert.equal(error.code, code);
          assert.equal(error.retryable, retryable);
          assert.doesNotMatch(error.message, new RegExp(API_KEY));
          return true;
        },
      );
    } finally {
      await server.close();
    }
  }
});

test("searchIdeas kiểm tham số trước khi gọi mạng (sai số chiều, limit)", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: { result: { groups: [] } } }));
  try {
    const store = new QdrantVectorStore(configFor(server.origin));
    for (const options of [
      { vectors: [[1, 0]], limit: 5 },
      { vectors: [], limit: 5 },
      { vectors: [[1, 0, 0]], limit: 0 },
    ]) {
      await assert.rejects(
        () => store.searchIdeas(options),
        (error: unknown) => error instanceof VectorStoreError && error.code === "BAD_REQUEST",
      );
    }
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("scrollIdeas lọc theo ideaId bằng match.any, phân trang, và không gửi request khi danh sách rỗng", async () => {
  const pages = [
    { points: [{ id: "p1", payload: storedPayload("GP-1") }], next_page_offset: "p2" },
    { points: [{ id: "p2", payload: storedPayload("GP-2") }], next_page_offset: null },
  ];
  const server = await startFakeServer((_request, index) => ({ status: 200, json: { result: pages[index] } }));
  try {
    const store = new QdrantVectorStore(configFor(server.origin));

    assert.deepEqual(await store.scrollIdeas([]), { points: [], truncated: false });
    assert.equal(server.requests.length, 0);

    const result = await store.scrollIdeas(["GP-1", "GP-2"]);

    assert.deepEqual(result.points.map((point) => point.payload.ideaId), ["GP-1", "GP-2"]);
    assert.equal(result.truncated, false);
    for (const request of server.requests) {
      assert.equal(request.url, "/collections/vnaip_dedup_test/points/scroll");
      assert.deepEqual(request.body.filter, { must: [{ key: "ideaId", match: { any: ["GP-1", "GP-2"] } }] });
      assert.equal(request.body.with_vector, false);
    }
    assert.equal(server.requests[1]!.body.offset, "p2");
  } finally {
    await server.close();
  }
});

test("scrollIdeas báo truncated khi chạm maxPoints và từ chối ideaId rỗng", async () => {
  const server = await startFakeServer(() => ({
    status: 200,
    json: { result: { points: [{ id: "p1", payload: storedPayload() }], next_page_offset: "p2" } },
  }));
  try {
    const store = new QdrantVectorStore(configFor(server.origin));
    const result = await store.scrollIdeas(["GP-1"], { maxPoints: 1 });
    assert.equal(result.truncated, true);

    await assert.rejects(
      () => store.scrollIdeas([""]),
      (error: unknown) => error instanceof VectorStoreError && error.code === "BAD_REQUEST",
    );
  } finally {
    await server.close();
  }
});
