import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createQdrantCandidateFinder,
  groupChunksIntoCandidates,
} from "../candidate-source.js";
import { DedupError, type DedupInput } from "../dedup.js";
import { RECORD_TYPES, type RecordType } from "../record-type.js";
import {
  VectorStoreError,
  createInMemoryVectorStores,
  pointId,
  type IdeaChunkPayload,
  type StoredChunk,
  type VectorPoint,
  type VectorStoreSet,
} from "../vector-store.js";

const DIMENSIONS = 3;
const input: DedupInput = { type: "solutions", title: "t", content: "c" };
/** Vector truy vấn mặc định: trùng hướng với vector mặc định [1, 0, 0] của `point()`. */
const query = { vectors: [[1, 0, 0]], limit: 20 };

function payload(overrides: Partial<IdeaChunkPayload> & { ideaId: string }): IdeaChunkPayload {
  return {
    type: "solutions",
    title: `Tiêu đề ${overrides.ideaId}`,
    chunkIndex: 0,
    chunkCount: 1,
    content: `Nội dung ${overrides.ideaId}`,
    metadata: {},
    embeddingModel: "test-model",
    indexedAt: "2026-11-04T00:00:00.000Z",
    ...overrides,
  };
}

function point(
  overrides: Partial<IdeaChunkPayload> & { ideaId: string },
  vector: number[] = [1, 0, 0],
): VectorPoint {
  const body = payload(overrides);
  return { id: pointId(body.ideaId, body.chunkIndex), vector, payload: body };
}

function stored(overrides: Partial<IdeaChunkPayload> & { ideaId: string }): StoredChunk {
  const body = payload(overrides);
  return { id: pointId(body.ideaId, body.chunkIndex), payload: body };
}

/** Bộ ba kho; `solutions` (type của `input`) là kho được test nạp dữ liệu mặc định. */
function makeStores(): VectorStoreSet {
  return createInMemoryVectorStores(DIMENSIONS);
}

/** Ghi lại collection nào bị tìm (searchIdeas) và bị đọc nội dung (scrollIdeas). */
function spyOnStores(stores: VectorStoreSet) {
  const searched: RecordType[] = [];
  const scrolled: RecordType[] = [];
  for (const type of RECORD_TYPES) {
    const store = stores.forType(type);
    const originalSearch = store.searchIdeas.bind(store);
    store.searchIdeas = async (options) => {
      searched.push(type);
      return originalSearch(options);
    };
    const originalScroll = store.scrollIdeas.bind(store);
    store.scrollIdeas = async (ideaIds, options) => {
      scrolled.push(type);
      return originalScroll(ideaIds, options);
    };
  }
  return { searched, scrolled };
}

test("gom các chunk của một sáng kiến theo thứ tự chunkIndex, nối bằng dòng trống", () => {
  const candidates = groupChunksIntoCandidates(
    [
      stored({ ideaId: "a", chunkIndex: 2, chunkCount: 3, content: "ba" }),
      stored({ ideaId: "a", chunkIndex: 0, chunkCount: 3, content: "một" }),
      stored({ ideaId: "a", chunkIndex: 1, chunkCount: 3, content: "hai" }),
    ],
    "solutions",
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.id, "a");
  assert.equal(candidates[0]!.content, "một\n\nhai\n\nba");
  assert.equal(candidates[0]!.title, "Tiêu đề a");
  assert.equal(candidates[0]!.type, "solutions");
});

test("chốt chặn thứ hai: chunk mang type khác (hoặc type cũ/lạ) lọt vào không bao giờ thành ứng viên", () => {
  const candidates = groupChunksIntoCandidates(
    [
      stored({ ideaId: "gp-1", type: "solutions" }),
      stored({ ideaId: "yt-1", type: "ideas" }),
      stored({ ideaId: "sk-1", type: "initiatives" }),
      // Dữ liệu hỏng/cũ: giá trị ngoài danh sách (ví dụ type số ít của bản trước).
      stored({ ideaId: "old-1", type: "solution" as RecordType }),
      stored({ ideaId: "x-1", type: "" as RecordType }),
    ],
    "solutions",
  );

  assert.deepEqual(candidates.map((c) => c.id), ["gp-1"]);
  assert.ok(candidates.every((c) => c.type === "solutions"));
});

test("kết quả sắp theo id để chia batch ổn định giữa các lần gọi", () => {
  const candidates = groupChunksIntoCandidates(
    [stored({ ideaId: "c" }), stored({ ideaId: "a" }), stored({ ideaId: "b" })],
    "solutions",
  );

  assert.deepEqual(candidates.map((c) => c.id), ["a", "b", "c"]);
});

test("index lại với ít chunk hơn: chunk đuôi cũ chưa kịp xoá bị bỏ, tiêu đề lấy từ lần index mới nhất", () => {
  const candidates = groupChunksIntoCandidates(
    [
      // Lần index cũ: 3 chunk.
      stored({ ideaId: "a", chunkIndex: 0, chunkCount: 3, content: "cũ-0", title: "Tiêu đề cũ", indexedAt: "2026-11-01T00:00:00.000Z" }),
      stored({ ideaId: "a", chunkIndex: 1, chunkCount: 3, content: "cũ-1", title: "Tiêu đề cũ", indexedAt: "2026-11-01T00:00:00.000Z" }),
      stored({ ideaId: "a", chunkIndex: 2, chunkCount: 3, content: "cũ-2", title: "Tiêu đề cũ", indexedAt: "2026-11-01T00:00:00.000Z" }),
      // Lần index mới: 2 chunk, đã ghi đè 0 và 1; chunk 2 cũ còn sót.
      stored({ ideaId: "a", chunkIndex: 0, chunkCount: 2, content: "mới-0", title: "Tiêu đề mới", indexedAt: "2026-11-04T00:00:00.000Z" }),
      stored({ ideaId: "a", chunkIndex: 1, chunkCount: 2, content: "mới-1", title: "Tiêu đề mới", indexedAt: "2026-11-04T00:00:00.000Z" }),
    ],
    "solutions",
  );

  assert.equal(candidates[0]!.content, "mới-0\n\nmới-1");
  assert.equal(candidates[0]!.title, "Tiêu đề mới");
});

test("thiếu một chunk giữa chừng thì vẫn giữ sáng kiến (không che mất ứng viên có thể trùng)", () => {
  const candidates = groupChunksIntoCandidates(
    [
      stored({ ideaId: "a", chunkIndex: 0, chunkCount: 3, content: "một" }),
      stored({ ideaId: "a", chunkIndex: 2, chunkCount: 3, content: "ba" }),
    ],
    "solutions",
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.content, "một\n\nba");
});

test("finder gom nhiều chunk của một sáng kiến và trả ứng viên theo thứ hạng độ gần, không theo id", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([
    // "a" xa truy vấn nhất, "b" gần nhất, "c" ở giữa: thứ hạng phải là b, c, a (không phải a, b, c).
    point({ ideaId: "a", chunkIndex: 0, chunkCount: 2, content: "a0" }, [0, 1, 0]),
    point({ ideaId: "a", chunkIndex: 1, chunkCount: 2, content: "a1" }, [0, 1, 0]),
    point({ ideaId: "b", content: "b0" }, [1, 0, 0]),
    point({ ideaId: "c", content: "c0" }, [1, 1, 0]),
  ]);

  const candidates = await createQdrantCandidateFinder(stores)(input, query);

  assert.deepEqual(
    candidates.map((c) => [c.id, c.content]),
    [
      ["b", "b0"],
      ["c", "c0"],
      ["a", "a0\n\na1"],
    ],
  );
});

test("kho rỗng trả danh sách rỗng và không đọc nội dung", async () => {
  const stores = makeStores();
  const { scrolled } = spyOnStores(stores);

  assert.deepEqual(await createQdrantCandidateFinder(stores)(input, query), []);
  assert.deepEqual(scrolled, []);
});

// --- top-k ---

test("chỉ trả k sáng kiến gần nhất, không phải cả kho", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([
    point({ ideaId: "gan-1" }, [1, 0, 0]),
    point({ ideaId: "gan-2" }, [0.9, 0.1, 0]),
    point({ ideaId: "xa-1" }, [0, 1, 0]),
    point({ ideaId: "xa-2" }, [0, 0, 1]),
  ]);

  const candidates = await createQdrantCandidateFinder(stores)(input, { vectors: [[1, 0, 0]], limit: 2 });

  assert.deepEqual(candidates.map((c) => c.id), ["gan-1", "gan-2"]);
});

test("k đếm SÁNG KIẾN chứ không đếm chunk: nhiều chunk cùng gần không chiếm hết k", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([
    // "dai" có 3 chunk đều rất gần; nếu k đếm chunk thì top-2 chỉ còn 1 sáng kiến.
    point({ ideaId: "dai", chunkIndex: 0, chunkCount: 3, content: "d0" }, [1, 0, 0]),
    point({ ideaId: "dai", chunkIndex: 1, chunkCount: 3, content: "d1" }, [0.99, 0.01, 0]),
    point({ ideaId: "dai", chunkIndex: 2, chunkCount: 3, content: "d2" }, [0.98, 0.02, 0]),
    point({ ideaId: "ngan" }, [0.5, 0.5, 0]),
  ]);

  const candidates = await createQdrantCandidateFinder(stores)(input, { vectors: [[1, 0, 0]], limit: 2 });

  assert.deepEqual(candidates.map((c) => c.id), ["dai", "ngan"]);
});

test("model thấy NỘI DUNG ĐẦY ĐỦ của ứng viên, kể cả chunk không khớp vector", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([
    point({ ideaId: "a", chunkIndex: 0, chunkCount: 2, content: "đoạn khớp" }, [1, 0, 0]),
    // Chunk này gần như vuông góc với truy vấn nhưng vẫn thuộc sáng kiến "a".
    point({ ideaId: "a", chunkIndex: 1, chunkCount: 2, content: "đoạn không khớp" }, [0, 1, 0]),
  ]);

  const [candidate] = await createQdrantCandidateFinder(stores)(input, query);

  assert.equal(candidate!.content, "đoạn khớp\n\nđoạn không khớp");
});

test("nhiều vector truy vấn: điểm của sáng kiến là điểm CAO NHẤT giữa các đoạn input", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([
    point({ ideaId: "gan-doan-1" }, [1, 0, 0]),
    point({ ideaId: "gan-doan-2" }, [0, 1, 0]),
    point({ ideaId: "xa-ca-hai" }, [0, 0, 1]),
  ]);

  const candidates = await createQdrantCandidateFinder(stores)(input, {
    vectors: [[1, 0, 0], [0, 1, 0]],
    limit: 2,
  });

  assert.deepEqual(candidates.map((c) => c.id).sort(), ["gan-doan-1", "gan-doan-2"]);
});

test("excludeIds được loại ngay trong truy vấn nên không chiếm chỗ của k", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([
    // "chinh-no" là bản chính hồ sơ đang sửa: giống input nhất và bị loại.
    point({ ideaId: "chinh-no" }, [1, 0, 0]),
    point({ ideaId: "b" }, [0.9, 0.1, 0]),
    point({ ideaId: "c" }, [0.8, 0.2, 0]),
    point({ ideaId: "d" }, [0, 1, 0]),
  ]);

  const candidates = await createQdrantCandidateFinder(stores)(
    { ...input, excludeIds: ["chinh-no", "khong-ton-tai"] },
    { vectors: [[1, 0, 0]], limit: 2 },
  );

  assert.deepEqual(candidates.map((c) => c.id), ["b", "c"], "vẫn đủ k=2 dù sáng kiến gần nhất bị loại");
});

// --- Tách collection theo type: luồng check chỉ đọc collection của type được hỏi ---

test("chỉ tìm và đọc collection của type được hỏi; hai collection còn lại không bị mở ra", async () => {
  for (const asked of RECORD_TYPES) {
    const stores = makeStores();
    await stores.forType(asked).upsertChunks([point({ ideaId: "a", type: asked })]);
    const { searched, scrolled } = spyOnStores(stores);

    await createQdrantCandidateFinder(stores)({ ...input, type: asked }, query);

    assert.deepEqual(searched, [asked], `hỏi ${asked} thì chỉ tìm trong collection ${asked}`);
    assert.deepEqual(scrolled, [asked], `hỏi ${asked} thì chỉ đọc collection ${asked}`);
  }
});

test("ba type chứa CÙNG ideaId và cùng nội dung vẫn không lẫn: mỗi type chỉ thấy bản của mình", async () => {
  const stores = makeStores();
  for (const type of RECORD_TYPES) {
    await stores.forType(type).upsertChunks([
      point({ ideaId: "X-1", type, title: `Tiêu đề ${type}`, content: `Nội dung riêng của ${type}` }),
    ]);
  }
  // Mỗi type có thêm một sáng kiến duy nhất của riêng nó, kém gần hơn X-1.
  for (const type of RECORD_TYPES) {
    await stores.forType(type).upsertChunks([point({ ideaId: `ONLY-${type}`, type }, [0.5, 0.5, 0])]);
  }

  for (const asked of RECORD_TYPES) {
    const candidates = await createQdrantCandidateFinder(stores)({ ...input, type: asked }, query);

    assert.deepEqual(candidates.map((c) => c.id), ["X-1", `ONLY-${asked}`]);
    assert.ok(candidates.every((c) => c.type === asked));
    const shared = candidates.find((c) => c.id === "X-1")!;
    assert.equal(shared.title, `Tiêu đề ${asked}`);
    assert.equal(shared.content, `Nội dung riêng của ${asked}`);
  }
});

test("dữ liệu chỉ có ở collection khác thì type được hỏi thấy kho rỗng (không so chéo)", async () => {
  const stores = makeStores();
  await stores.forType("ideas").upsertChunks([point({ ideaId: "I-1", type: "ideas", content: "Báo cáo sự cố." })]);
  await stores.forType("initiatives").upsertChunks([point({ ideaId: "N-1", type: "initiatives", content: "Báo cáo sự cố." })]);

  const finder = createQdrantCandidateFinder(stores);
  assert.deepEqual(await finder({ ...input, type: "solutions" }, query), []);
  assert.deepEqual((await finder({ ...input, type: "ideas" }, query)).map((c) => c.id), ["I-1"]);
  assert.deepEqual((await finder({ ...input, type: "initiatives" }, query)).map((c) => c.id), ["N-1"]);
});

test("chunk lạc type nằm trong collection thì bị bỏ qua và để lại dấu vết trong log, không im lặng", async () => {
  const stores = makeStores();
  const solutions = stores.forType("solutions");
  await solutions.upsertChunks([point({ ideaId: "gp-1", content: "NỘI DUNG BÍ MẬT" })]);
  // Giả lập dữ liệu bị ghi lệch (store thật từ chối ghi kiểu này nên phải chèn ở tầng đọc).
  const original = solutions.scrollIdeas.bind(solutions);
  solutions.scrollIdeas = async (ideaIds, options) => {
    const result = await original(ideaIds, options);
    return { ...result, points: [...result.points, stored({ ideaId: "lac-1", type: "ideas" })] };
  };
  const logged: Array<[string, Record<string, unknown>]> = [];

  const candidates = await createQdrantCandidateFinder(stores, {
    log: (event, details) => logged.push([event, details]),
  })(input, query);

  assert.deepEqual(candidates.map((c) => c.id), ["gp-1"]);
  const warning = logged.find(([event]) => event === "candidates_foreign_type_ignored");
  assert.deepEqual(warning?.[1], { type: "solutions", chunks: 1 });
  assert.doesNotMatch(JSON.stringify(logged), /BÍ MẬT|lac-1/);
});

test("type lạ (kể cả \"solution\" cũ) bị từ chối INVALID_TYPE trước khi tạo collection, tìm hay đọc bất cứ gì", async () => {
  const stores = makeStores();
  const { searched, scrolled } = spyOnStores(stores);
  let ensured = 0;

  for (const bogus of ["solution", "idea", "other", ""]) {
    await assert.rejects(
      () =>
        createQdrantCandidateFinder(stores, {
          ensureReady: async () => {
            ensured += 1;
          },
        })({ ...input, type: bogus as RecordType }, query),
      (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_TYPE",
    );
  }
  assert.equal(ensured, 0);
  assert.deepEqual(searched, []);
  assert.deepEqual(scrolled, []);
});

// --- Giới hạn đọc nội dung ---

test("đọc nội dung bị cắt (chạm maxPoints) thì ném CANDIDATE_LIMIT_EXCEEDED, không trả ứng viên cụt nội dung", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([
    point({ ideaId: "a", chunkIndex: 0, chunkCount: 2 }),
    point({ ideaId: "a", chunkIndex: 1, chunkCount: 2 }),
    point({ ideaId: "b" }),
  ]);

  await assert.rejects(
    () => createQdrantCandidateFinder(stores, { maxPoints: 2 })(input, query),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, "CANDIDATE_LIMIT_EXCEEDED");
      return true;
    },
  );
});

test("maxPoints chỉ tính chunk của các sáng kiến top-k, không tính cả kho hay type khác", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([
    point({ ideaId: "a" }, [1, 0, 0]),
    point({ ideaId: "b" }, [0.9, 0.1, 0]),
    // Cả kho có nhiều chunk hơn maxPoints, nhưng top-k=2 chỉ cần đọc 2 chunk.
    ...Array.from({ length: 10 }, (_, i) => point({ ideaId: `xa-${i}` }, [0, 1, 0])),
  ]);
  await stores.forType("ideas").upsertChunks(
    Array.from({ length: 10 }, (_, i) => point({ ideaId: `i-${i}`, type: "ideas" })),
  );

  const candidates = await createQdrantCandidateFinder(stores, { maxPoints: 2 })(input, {
    vectors: [[1, 0, 0]],
    limit: 2,
  });
  assert.deepEqual(candidates.map((c) => c.id), ["a", "b"]);
});

// --- Vận hành ---

test("ensureReady nhận đúng type và chạy trước lần tìm; lỗi của nó làm lời gọi lỗi", async () => {
  const stores = makeStores();
  const order: string[] = [];
  const solutions = stores.forType("solutions");
  const originalSearch = solutions.searchIdeas.bind(solutions);
  solutions.searchIdeas = async (options) => {
    order.push("search");
    return originalSearch(options);
  };

  await createQdrantCandidateFinder(stores, {
    ensureReady: async (type) => {
      order.push(`ready:${type}`);
    },
  })(input, query);
  assert.deepEqual(order, ["ready:solutions", "search"]);

  await assert.rejects(
    () =>
      createQdrantCandidateFinder(stores, {
        ensureReady: async () => {
          throw new Error("collection lệch cấu hình");
        },
      })(input, query),
    /collection lệch cấu hình/,
  );
});

test("lỗi tìm kiếm của store propagate (không bị nuốt thành danh sách rỗng)", async () => {
  const stores = makeStores();
  stores.forType("solutions").searchIdeas = async () => {
    throw new Error("Qdrant down");
  };

  await assert.rejects(() => createQdrantCandidateFinder(stores)(input, query), /Qdrant down/);
});

test("lỗi đọc nội dung của store propagate", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([point({ ideaId: "a" })]);
  stores.forType("solutions").scrollIdeas = async () => {
    throw new Error("Qdrant down khi đọc nội dung");
  };

  await assert.rejects(() => createQdrantCandidateFinder(stores)(input, query), /Qdrant down khi đọc/);
});

test("lỗi ở collection khác không ảnh hưởng type được hỏi", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([point({ ideaId: "a" })]);
  stores.forType("ideas").searchIdeas = async () => {
    throw new Error("collection ideas hỏng");
  };

  assert.deepEqual((await createQdrantCandidateFinder(stores)(input, query)).map((c) => c.id), ["a"]);
});

test("sáng kiến bị xoá giữa lúc tìm và lúc đọc nội dung thì bị bỏ qua, các sáng kiến còn lại vẫn trả", async () => {
  const stores = makeStores();
  const solutions = stores.forType("solutions");
  await solutions.upsertChunks([point({ ideaId: "a" }, [1, 0, 0]), point({ ideaId: "b" }, [0.9, 0.1, 0])]);
  const original = solutions.scrollIdeas.bind(solutions);
  solutions.scrollIdeas = async (ideaIds, options) => {
    await solutions.deleteIdea("a");
    return original(ideaIds, options);
  };

  const candidates = await createQdrantCandidateFinder(stores)(input, query);

  assert.deepEqual(candidates.map((c) => c.id), ["b"]);
});

test("log số vector, số hit, chunk, sáng kiến và điểm gần/xa nhất; không có nội dung", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([
    point({ ideaId: "a", content: "NỘI DUNG BÍ MẬT" }, [1, 0, 0]),
    point({ ideaId: "b", content: "NỘI DUNG BÍ MẬT" }, [0, 1, 0]),
  ]);
  const logged: Array<[string, Record<string, unknown>]> = [];

  await createQdrantCandidateFinder(stores, {
    log: (event, details) => logged.push([event, details]),
  })(input, query);

  assert.equal(logged[0]![0], "candidates_loaded");
  assert.equal(logged[0]![1].type, "solutions");
  assert.equal(logged[0]![1].queryVectors, 1);
  assert.equal(logged[0]![1].hits, 2);
  assert.equal(logged[0]![1].chunks, 2);
  assert.equal(logged[0]![1].ideas, 2);
  assert.equal(logged[0]![1].topScore, 1);
  assert.equal(logged[0]![1].lastScore, 0);
  assert.doesNotMatch(JSON.stringify(logged), /BÍ MẬT/);
});

// --- Embedding model phải khớp model đã index ---

test("sáng kiến do embedding model khác index thì báo CANDIDATES_UNAVAILABLE và không đọc nội dung (thứ hạng vô nghĩa)", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([
    point({ ideaId: "moi", embeddingModel: "gemini-embedding-001" }),
    point({ ideaId: "gia", embeddingModel: "mock-embedding" }),
  ]);
  const { scrolled } = spyOnStores(stores);
  const logged: Array<[string, Record<string, unknown>]> = [];

  await assert.rejects(
    () =>
      createQdrantCandidateFinder(stores, {
        embeddingModel: "gemini-embedding-001",
        log: (event, details) => logged.push([event, details]),
      })(input, query),
    (error: unknown) => error instanceof DedupError && error.code === "CANDIDATES_UNAVAILABLE",
  );

  assert.deepEqual(scrolled, []);
  const warning = logged.find(([event]) => event === "candidates_embedding_model_mismatch");
  assert.deepEqual(warning?.[1], {
    type: "solutions",
    expected: "gemini-embedding-001",
    indexedWith: ["mock-embedding"],
    hits: 2,
    mismatched: 1,
  });
});

test("tên model có hoặc không có tiền tố \"models/\" được coi là cùng một model", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([point({ ideaId: "a", embeddingModel: "gemini-embedding-001" })]);

  for (const configured of ["gemini-embedding-001", "models/gemini-embedding-001"]) {
    const candidates = await createQdrantCandidateFinder(stores, { embeddingModel: configured })(input, query);
    assert.deepEqual(candidates.map((c) => c.id), ["a"], configured);
  }
});

test("không đặt embeddingModel (embedding mock) thì không kiểm nhãn model", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([point({ ideaId: "a", embeddingModel: "mock-embedding" })]);

  assert.deepEqual((await createQdrantCandidateFinder(stores)(input, query)).map((c) => c.id), ["a"]);
});
