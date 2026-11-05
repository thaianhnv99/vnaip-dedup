import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EmbeddingError,
  createEmbedderFromEnv,
  createMockEmbedder,
  createHttpEmbedder,
  loadEmbeddingConfig,
  type EmbeddingConfig,
} from "../embeddings.js";
import { startFakeServer } from "./helpers/fake-http-server.js";

const DIMS = 4;
const API_KEY = "sk-or-test-secret-key";

function configFor(origin: string, overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    baseUrl: `${origin}/v1beta`,
    apiKey: API_KEY,
    model: "gemini-embedding-001",
    dimensions: DIMS,
    timeoutMs: 2000,
    batchSize: 64,
    ...overrides,
  };
}

function vectorFor(seed: number): number[] {
  return [seed + 1, seed + 1.5, seed + 2, seed + 2.5];
}

/** Client tự chuẩn hoá L2 (Gemini không chuẩn hoá khi cắt khỏi 3072 chiều). */
function unit(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

/** Response `batchEmbedContents`: `embeddings[i].values`, đúng thứ tự request, không có `index`. */
function okBody(count: number) {
  return {
    embeddings: [...Array(count).keys()].map((index) => ({ values: vectorFor(index) })),
    usageMetadata: { promptTokenCount: count },
  };
}

test("gọi :batchEmbedContents với khoá ở header x-goog-api-key và trả vector theo thứ tự đầu vào", async () => {
  const server = await startFakeServer((request) => ({
    status: 200,
    json: okBody(request.body.requests.length),
  }));
  try {
    const embed = createHttpEmbedder(configFor(server.origin));
    const vectors = await embed(["a", "b", "c"]);

    assert.deepEqual(vectors, [0, 1, 2].map((seed) => unit(vectorFor(seed))));
    const [request] = server.requests;
    assert.equal(request!.method, "POST");
    assert.equal(request!.url, "/v1beta/models/gemini-embedding-001:batchEmbedContents");
    assert.equal(request!.headers["x-goog-api-key"], API_KEY);
    // Khoá KHÔNG đi qua Authorization hay query string (query string dễ lọt vào log).
    assert.equal(request!.headers.authorization, undefined);
    assert.doesNotMatch(request!.url, /key=|test-secret/);
    // `outputDimensionality` (trong embedContentConfig) luôn được gửi: gemini-embedding-001 mặc
    // định ra 3072 chiều, còn collection Qdrant là 1536 (xem DEFAULT_EMBEDDING_DIMENSIONS).
    assert.deepEqual(request!.body, {
      requests: ["a", "b", "c"].map((text) => ({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text }] },
        embedContentConfig: { outputDimensionality: DIMS },
      })),
    });
  } finally {
    await server.close();
  }
});

test("tên model có tiền tố models/ vẫn gọi đúng đường dẫn", async () => {
  const server = await startFakeServer((request) => ({
    status: 200,
    json: okBody(request.body.requests.length),
  }));
  try {
    await createHttpEmbedder(configFor(server.origin, { model: "models/gemini-embedding-001" }))(["a"]);
    assert.equal(server.requests[0]!.url, "/v1beta/models/gemini-embedding-001:batchEmbedContents");
    assert.equal(server.requests[0]!.body.requests[0].model, "models/gemini-embedding-001");
  } finally {
    await server.close();
  }
});

test("vector trả về được chuẩn hoá L2; vector không giữ nguyên (không sinh NaN)", async () => {
  const server = await startFakeServer(() => ({
    status: 200,
    json: { embeddings: [{ values: [3, 0, 4, 0] }, { values: [0, 0, 0, 0] }] },
  }));
  try {
    const [first, zero] = await createHttpEmbedder(configFor(server.origin))(["a", "b"]);
    assert.deepEqual(first, [0.6, 0, 0.8, 0]);
    assert.deepEqual(zero, [0, 0, 0, 0]);
  } finally {
    await server.close();
  }
});

test("chia batch theo batchSize và ghép kết quả đúng thứ tự", async () => {
  const server = await startFakeServer((request) => ({
    status: 200,
    json: {
      embeddings: request.body.requests.map((item: any) => ({
        values: vectorFor(Number(item.content.parts[0].text)),
      })),
    },
  }));
  try {
    const embed = createHttpEmbedder(configFor(server.origin, { batchSize: 2 }));
    const vectors = await embed(["0", "1", "2", "3", "4"]);

    assert.equal(server.requests.length, 3);
    assert.deepEqual(
      server.requests.map((request) => request.body.requests.map((item: any) => item.content.parts[0].text)),
      [["0", "1"], ["2", "3"], ["4"]],
    );
    assert.deepEqual(vectors, [0, 1, 2, 3, 4].map((seed) => unit(vectorFor(seed))));
  } finally {
    await server.close();
  }
});

test("danh sách rỗng không gọi mạng", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: okBody(0) }));
  try {
    const embed = createHttpEmbedder(configFor(server.origin));
    assert.deepEqual(await embed([]), []);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("văn bản rỗng bị từ chối trước khi gọi mạng", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: okBody(1) }));
  try {
    const embed = createHttpEmbedder(configFor(server.origin));
    await assert.rejects(
      () => embed(["ok", "   "]),
      (error: unknown) => error instanceof EmbeddingError && error.code === "INVALID_INPUT",
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("response sai số chiều hoặc sai số lượng bị coi là BAD_RESPONSE", async () => {
  const wrongDimension = await startFakeServer(() => ({
    status: 200,
    json: { embeddings: [{ values: [1, 2] }] },
  }));
  const wrongCount = await startFakeServer(() => ({ status: 200, json: okBody(1) }));
  // Dạng response của endpoint tương thích OpenAI (`data[].embedding`) không còn được chấp nhận.
  const openAiShape = await startFakeServer(() => ({
    status: 200,
    json: { data: [{ index: 0, embedding: vectorFor(0) }] },
  }));
  const noValues = await startFakeServer(() => ({ status: 200, json: { embeddings: [{}] } }));
  try {
    await assert.rejects(
      () => createHttpEmbedder(configFor(wrongDimension.origin))(["a"]),
      (error: unknown) => error instanceof EmbeddingError && error.code === "BAD_RESPONSE",
    );
    await assert.rejects(
      () => createHttpEmbedder(configFor(wrongCount.origin))(["a", "b"]),
      (error: unknown) => error instanceof EmbeddingError && error.code === "BAD_RESPONSE",
    );
    await assert.rejects(
      () => createHttpEmbedder(configFor(openAiShape.origin))(["a"]),
      (error: unknown) =>
        error instanceof EmbeddingError && error.code === "BAD_RESPONSE" && /embeddings/.test(error.message),
    );
    await assert.rejects(
      () => createHttpEmbedder(configFor(noValues.origin))(["a"]),
      (error: unknown) => error instanceof EmbeddingError && error.code === "BAD_RESPONSE" && /values/.test(error.message),
    );
  } finally {
    await wrongDimension.close();
    await wrongCount.close();
    await openAiShape.close();
    await noValues.close();
  }
});

test("map mã HTTP sang mã lỗi và cờ retryable đúng, không lộ API key", async () => {
  const cases: Array<[number, string, boolean]> = [
    [401, "AUTH_ERROR", false],
    [402, "BAD_REQUEST", false],
    [400, "BAD_REQUEST", false],
    [429, "RATE_LIMITED", true],
    [503, "UPSTREAM_ERROR", true],
  ];
  for (const [status, code, retryable] of cases) {
    const server = await startFakeServer(() => ({
      status,
      json: { error: { message: `echo ${API_KEY} và nội dung nhạy cảm` } },
    }));
    try {
      const embed = createHttpEmbedder(configFor(server.origin));
      await assert.rejects(
        () => embed(["nội dung hồ sơ nhạy cảm"]),
        (error: unknown) => {
          assert.ok(error instanceof EmbeddingError);
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
});

test("quá thời gian trả TIMEOUT và cho phép retry", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: okBody(1), delayMs: 300 }));
  try {
    const embed = createHttpEmbedder(configFor(server.origin, { timeoutMs: 50 }));
    await assert.rejects(
      () => embed(["a"]),
      (error: unknown) =>
        error instanceof EmbeddingError && error.code === "TIMEOUT" && error.retryable,
    );
  } finally {
    await server.close();
  }
});

test("không kết nối được trả NETWORK_ERROR", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: okBody(1) }));
  const origin = server.origin;
  await server.close();
  const embed = createHttpEmbedder(configFor(origin));
  await assert.rejects(
    () => embed(["a"]),
    (error: unknown) =>
      error instanceof EmbeddingError && error.code === "NETWORK_ERROR" && error.retryable,
  );
});

test("thiếu GEMINI_API_KEY báo NOT_CONFIGURED; mock chỉ bật khi EMBEDDING_MOCK_MODE=true", () => {
  assert.throws(
    () => createEmbedderFromEnv({}),
    (error: unknown) => error instanceof EmbeddingError && error.code === "NOT_CONFIGURED",
  );
  assert.doesNotThrow(() => createEmbedderFromEnv({ EMBEDDING_MOCK_MODE: "true" }));
});

test("OPENROUTER_API_KEY không còn được đọc: chỉ có khoá cũ thì vẫn NOT_CONFIGURED và nói rõ lý do", () => {
  assert.equal(loadEmbeddingConfig({ OPENROUTER_API_KEY: "old-key" }).apiKey, "");
  assert.throws(
    () => createEmbedderFromEnv({ OPENROUTER_API_KEY: "old-key" }),
    (error: unknown) =>
      error instanceof EmbeddingError &&
      error.code === "NOT_CONFIGURED" &&
      /GEMINI_API_KEY/.test(error.message) &&
      !error.message.includes("old-key"),
  );
});

test("loadEmbeddingConfig dùng mặc định Gemini (1536 chiều khớp collection Qdrant hiện có)", () => {
  const config = loadEmbeddingConfig({ GEMINI_API_KEY: "k" });
  // API gốc của Gemini, KHÔNG phải endpoint tương thích OpenAI (/v1beta/openai) mà scorer dùng.
  assert.equal(config.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(config.apiKey, "k");
  assert.equal(config.model, "gemini-embedding-001");
  assert.equal(config.dimensions, 1536);
  assert.equal(config.batchSize, 64);

  const custom = loadEmbeddingConfig({ EMBEDDING_BASE_URL: "https://proxy.example.com/v1beta//", GEMINI_API_KEY: "k" });
  assert.equal(custom.baseUrl, "https://proxy.example.com/v1beta");
  // GEMINI_BASE_URL không còn tồn tại: không ảnh hưởng embedding.
  assert.equal(loadEmbeddingConfig({ GEMINI_BASE_URL: "https://x.example/openai", GEMINI_API_KEY: "k" }).baseUrl, config.baseUrl);
});

test("embedder giả: xác định, chuẩn hoá L2, văn bản giống nhau thì gần nhau hơn", async () => {
  const embed = createMockEmbedder(128);
  const [a1, a2, similar, different] = await embed([
    "ứng dụng báo cáo sự cố mặt đất",
    "ứng dụng báo cáo sự cố mặt đất",
    "ứng dụng báo cáo sự cố mặt đất theo thời gian thực",
    "quy trình tuyển dụng nhân sự mới",
  ]);

  assert.deepEqual(a1, a2);
  assert.equal(a1!.length, 128);
  const norm = Math.sqrt(a1!.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);

  const dot = (x: number[], y: number[]) => x.reduce((sum, value, i) => sum + value * y[i]!, 0);
  assert.ok(dot(a1!, similar!) > dot(a1!, different!));
});
