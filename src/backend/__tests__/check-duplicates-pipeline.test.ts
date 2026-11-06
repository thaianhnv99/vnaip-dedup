import { test } from "node:test";
import assert from "node:assert/strict";
import { createQdrantCandidateFinder } from "../candidate-source.js";
import { checkDuplicates, DedupError, type DedupDependencies, type DedupInput } from "../dedup.js";
import { processIndexJob, type IndexJob } from "../index-job.js";
import { createLlmScorer } from "../llm-scorer.js";
import { createMockEmbedder } from "../embeddings.js";
import { createInputEmbedder } from "../input-embedder.js";
import { createInMemoryVectorStores, type VectorStores } from "../vector-store.js";
import { RECORD_TYPES, type RecordType } from "../record-type.js";
import { assertValidDedupOutput } from "../validate-output.js";
import { startFakeServer, type RecordedRequest } from "./helpers/fake-http-server.js";

/**
 * Mốc MVP của kế hoạch: một sáng kiến được duyệt → được index → kiểm tra trùng tìm
 * thấy nó. Ghép các mảnh THẬT (processIndexJob, store, embed input, tìm top-k, scorer qua
 * HTTP, checkDuplicates, validate output); chỉ embedding là mock và Gemini là server giả.
 * Embedding mock là túi từ băm nên "gần" ở đây nghĩa là chung nhiều từ với input.
 */

const DIMS = 64;
const options = { topK: 100, deadlineMs: 5000 };

function job(ideaId: string, title: string, content: string, type: RecordType = "solutions"): IndexJob {
  return {
    jobId: `job-${ideaId}`,
    ideaId,
    type,
    title,
    content,
    metadata: {},
    receivedAt: "2026-11-04T00:00:00.000Z",
  };
}

async function seed(stores: VectorStores, jobs: IndexJob[], chunkChars = 2000) {
  for (const item of jobs) {
    await processIndexJob(item, {
      embed: createMockEmbedder(DIMS),
      stores,
      embeddingModel: "mock-embedding",
      chunkChars,
    });
  }
}

/** Gemini giả: chấm cao khi ứng viên chứa từ khoá "sự cố", thấp nếu không. */
function fakeScoring(request: RecordedRequest) {
  const payload = JSON.parse(request.body.messages[1].content) as {
    candidates: Array<{ candidateId: string; title: string; content: string }>;
  };
  const matches = payload.candidates.map((candidate) => ({
    id: candidate.candidateId,
    percent: /sự cố/i.test(`${candidate.title} ${candidate.content}`) ? 88 : 7,
    reason: "Đánh giá giả cho test",
  }));
  return { status: 200, json: { choices: [{ message: { content: JSON.stringify({ matches }) } }] } };
}

function buildDeps(stores: VectorStores, origin: string): DedupDependencies {
  return {
    embedInput: createInputEmbedder(createMockEmbedder(DIMS)),
    findCandidates: createQdrantCandidateFinder(stores),
    scoreCandidates: createLlmScorer({
      baseUrl: `${origin}/api/v1`,
      apiKey: "sk-test",
      model: "test/model",
      timeoutMs: 5000,
      batchSize: 10,
      concurrency: 10,
      maxCandidateChars: 4000,
    }),
  };
}

const input: DedupInput = {
  type: "solutions",
  title: "Báo cáo sự cố mặt đất bằng điện thoại",
  content: "Nhân viên báo cáo sự cố ngay tại hiện trường.",
};

test("sáng kiến đã index được tìm thấy; output đúng schema; sắp theo điểm giảm dần", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  await seed(stores, [
    job("GP-1", "Ứng dụng báo cáo sự cố mặt đất", "Báo cáo sự cố mặt đất theo thời gian thực."),
    job("GP-2", "Nền tảng dữ liệu dùng chung", "Lưu trữ và chia sẻ dữ liệu giữa các khối."),
  ]);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(input, buildDeps(stores, server.origin), options);

    assertValidDedupOutput(output);
    assert.deepEqual(
      output.matches.map((m) => [m.id, m.percent]),
      [
        ["GP-1", 88],
        ["GP-2", 7],
      ],
    );
    assert.equal(output.matches[0]!.score, 0.88);
    assert.equal(output.matches[0]!.type, "solutions");
  } finally {
    await server.close();
  }
});

test("excludeIds loại sáng kiến khỏi kết quả và khỏi prompt gửi model", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  await seed(stores, [
    job("GP-1", "Ứng dụng báo cáo sự cố mặt đất", "Báo cáo sự cố."),
    job("GP-2", "Báo cáo sự cố bằng QR", "Quét QR để báo sự cố."),
  ]);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(
      { ...input, excludeIds: ["GP-1"] },
      buildDeps(stores, server.origin),
      options,
    );

    assert.deepEqual(output.matches.map((m) => m.id), ["GP-2"]);
    assert.doesNotMatch(JSON.stringify(server.requests.map((r) => r.body)), /GP-1/);
  } finally {
    await server.close();
  }
});

test("sáng kiến nhiều chunk được ghép lại: model nhìn thấy nội dung của chunk cuối", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  const paragraphs = Array.from({ length: 5 }, (_, i) => `Đoạn ${i + 1}: ${"chi tiết ".repeat(8).trim()}.`);
  await seed(stores, [job("GP-LONG", "Sáng kiến dài", paragraphs.join("\n\n") + "\n\nĐoạn cuối nhắc tới sự cố hiện trường.")], 120);
  assert.ok((await stores.forType("solutions").scrollAll()).points.length > 1, "phải được chia thành nhiều chunk");
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(input, buildDeps(stores, server.origin), options);

    assert.equal(server.requests.length, 1);
    const sent = JSON.parse(server.requests[0]!.body.messages[1].content).candidates;
    assert.equal(sent.length, 1, "nhiều chunk của một sáng kiến chỉ là MỘT ứng viên");
    assert.match(sent[0].content, /Đoạn cuối nhắc tới sự cố hiện trường/);
    assert.deepEqual(output.matches.map((m) => m.id), ["GP-LONG"]);
  } finally {
    await server.close();
  }
});

/** Mỗi type một sáng kiến có NỘI DUNG GIỐNG HỆT nhau: nếu có lẫn type thì chắc chắn bị bắt. */
const SAME_TEXT = "Báo cáo sự cố mặt đất bằng điện thoại.";
const TWIN_IDS: Record<RecordType, string> = { ideas: "YT-1", solutions: "GP-1", initiatives: "SK-1" };

async function seedTwins(stores: VectorStores) {
  await seed(
    stores,
    RECORD_TYPES.map((type) => job(TWIN_IDS[type], `Báo cáo sự cố (${type})`, SAME_TEXT, type)),
  );
}

test("ba type có nội dung giống hệt nhau: kiểm tra mỗi type chỉ thấy và chỉ gửi model sáng kiến cùng type", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  await seedTwins(stores);

  for (const asked of RECORD_TYPES) {
    const server = await startFakeServer((request) => fakeScoring(request));
    try {
      const output = await checkDuplicates({ ...input, type: asked }, buildDeps(stores, server.origin), options);

      assertValidDedupOutput(output);
      assert.deepEqual(output.matches.map((m) => m.id), [TWIN_IDS[asked]], `hỏi ${asked}`);
      assert.ok(output.matches.every((m) => m.type === asked));
      // Sáng kiến của type khác không được rời khỏi collection để tới prompt của model.
      const sent = JSON.stringify(server.requests.map((request) => request.body));
      for (const other of RECORD_TYPES.filter((type) => type !== asked)) {
        assert.doesNotMatch(sent, new RegExp(TWIN_IDS[other]), `prompt của ${asked} lộ sáng kiến ${other}`);
      }
    } finally {
      await server.close();
    }
  }
});

test("type chưa có dữ liệu thì không match, dù type khác có sáng kiến y hệt (và không gọi model)", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  await seed(stores, [
    job("YT-1", "Báo cáo sự cố", SAME_TEXT, "ideas"),
    job("SK-1", "Báo cáo sự cố", SAME_TEXT, "initiatives"),
  ]);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates({ ...input, type: "solutions" }, buildDeps(stores, server.origin), options);
    assert.deepEqual(output.matches, []);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("model trả về id của sáng kiến thuộc type khác thì bị bỏ, không lọt vào kết quả", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  await seedTwins(stores);
  // Model "ảo giác" thêm id của hai type còn lại với điểm cao nhất.
  const server = await startFakeServer((request) => {
    const reply = fakeScoring(request);
    const honest = JSON.parse(reply.json.choices[0]!.message.content).matches;
    const forged = Object.values(TWIN_IDS).map((id) => ({ id, percent: 99, reason: "model bịa" }));
    return { ...reply, json: { choices: [{ message: { content: JSON.stringify({ matches: [...forged, ...honest] }) } }] } };
  });
  try {
    const output = await checkDuplicates({ ...input, type: "ideas" }, buildDeps(stores, server.origin), options);
    assert.deepEqual(output.matches.map((m) => [m.id, m.type]), [["YT-1", "ideas"]]);
  } finally {
    await server.close();
  }
});

test("type ngoài ideas/solutions/initiatives (kể cả \"solution\" cũ) bị từ chối INVALID_INPUT, không đọc kho, không gọi model", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  await seedTwins(stores);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    for (const bogus of ["solution", "idea", "initiative", "project", "other", "SOLUTIONS", ""]) {
      await assert.rejects(
        () => checkDuplicates({ ...input, type: bogus as RecordType }, buildDeps(stores, server.origin), options),
        (error: unknown) => error instanceof DedupError && error.code === "INVALID_INPUT",
      );
    }
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("kho rỗng trả matches rỗng và không gọi model", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(input, buildDeps(stores, server.origin), options);
    assert.deepEqual(output.matches, []);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("index lại một sáng kiến (nội dung mới) thì lần kiểm tra sau thấy bản mới, không nhân đôi", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  await seed(stores, [job("GP-1", "Nền tảng dữ liệu", "Lưu trữ dữ liệu dùng chung.")]);
  await seed(stores, [job("GP-1", "Báo cáo sự cố", "Đã đổi hướng sang báo cáo sự cố.")]);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(input, buildDeps(stores, server.origin), options);

    assert.equal(output.matches.length, 1);
    assert.equal(output.matches[0]!.percent, 88);
  } finally {
    await server.close();
  }
});

test("top-k: chỉ k sáng kiến gần input nhất tới được model; sáng kiến xa không bị gửi đi", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  await seed(stores, [
    job("GAN-1", "Báo cáo sự cố mặt đất bằng điện thoại", "Nhân viên báo cáo sự cố ngay tại hiện trường."),
    job("GAN-2", "Báo cáo sự cố hiện trường", "Báo cáo sự cố mặt đất bằng điện thoại cho nhân viên."),
    job("XA-1", "Nền tảng dữ liệu dùng chung", "Lưu trữ và chia sẻ dữ liệu giữa các khối nghiệp vụ."),
    job("XA-2", "Cổng thanh toán nội bộ", "Thanh toán hoá đơn và đối soát công nợ hằng tháng."),
    job("XA-3", "Hệ thống đặt lịch họp", "Đặt phòng họp và gửi lời mời cho người tham dự."),
  ]);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(input, buildDeps(stores, server.origin), { topK: 2, deadlineMs: 5000 });

    const sent = server.requests.flatMap((r) =>
      (JSON.parse(r.body.messages[1].content).candidates as Array<{ candidateId: string }>).map((c) => c.candidateId),
    );
    assert.deepEqual([...sent].sort(), ["GAN-1", "GAN-2"], "chỉ hai sáng kiến gần nhất được gửi");
    assert.deepEqual(output.matches.map((m) => m.id).sort(), ["GAN-1", "GAN-2"]);
  } finally {
    await server.close();
  }
});

test("kho 50 sáng kiến, k=20: model chỉ nhận đúng 20 ứng viên và vẫn thấy cả 5 sáng kiến liên quan", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  await seed(stores, [
    ...Array.from({ length: 5 }, (_, i) =>
      job(`LQ-${i}`, `Báo cáo sự cố mặt đất ${i}`, "Báo cáo sự cố ngay tại hiện trường bằng điện thoại."),
    ),
    ...Array.from({ length: 45 }, (_, i) =>
      job(`KHAC-${String(i).padStart(2, "0")}`, `Chủ đề ${i} về kế toán`, `Đối soát công nợ kỳ ${i} và lập báo cáo thuế.`),
    ),
  ]);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(input, buildDeps(stores, server.origin), { topK: 20, deadlineMs: 5000 });

    const sent = server.requests.flatMap(
      (r) => JSON.parse(r.body.messages[1].content).candidates as Array<{ candidateId: string }>,
    );
    assert.equal(sent.length, 20, "20 trong 50 sáng kiến, không phải cả kho");
    assert.equal(server.requests.length, 2, "20 ứng viên chia 2 batch 10");
    const relevant = output.matches.filter((m) => m.percent === 88).map((m) => m.id).sort();
    assert.deepEqual(relevant, ["LQ-0", "LQ-1", "LQ-2", "LQ-3", "LQ-4"], "5 sáng kiến liên quan phải nằm trong top-20");
  } finally {
    await server.close();
  }
});

test("input dài được chia đoạn và embed trong MỘT request; sáng kiến khớp một đoạn ở cuối input vẫn được tìm thấy", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  await seed(stores, [
    job("GP-SU-CO", "Ứng dụng báo cáo sự cố", "Báo cáo sự cố ngay tại hiện trường bằng điện thoại."),
    job("GP-KHAC", "Cổng thanh toán nội bộ", "Thanh toán hoá đơn và đối soát công nợ hằng tháng."),
  ]);
  const embedCalls: string[][] = [];
  const mock = createMockEmbedder(DIMS);
  const deps: DedupDependencies = {
    ...buildDeps(stores, "http://unused.invalid"),
    embedInput: createInputEmbedder(async (texts) => {
      embedCalls.push(texts);
      return mock(texts);
    }, { chunkChars: 120 }),
    scoreCandidates: async (_input, candidates) =>
      candidates.map((c) => ({ id: c.id, percent: /sự cố/i.test(c.content) ? 90 : 5, reason: "giả" })),
  };
  // Hồ sơ dài: đoạn đầu chẳng liên quan sáng kiến nào, chỉ đoạn cuối mới nói về báo cáo sự cố.
  const longInput: DedupInput = {
    type: "solutions",
    title: "Hồ sơ dài",
    content: [
      "Thời tiết hôm nay nắng đẹp, trời trong xanh, gió nhẹ, nhiệt độ vừa phải cho chuyến dã ngoại cuối tuần.",
      "Báo cáo sự cố ngay tại hiện trường bằng điện thoại.",
    ].join("\n\n"),
  };

  const output = await checkDuplicates(longInput, deps, { topK: 1, deadlineMs: 5000 });

  assert.equal(embedCalls.length, 1, "một request embedding cho mọi đoạn");
  assert.equal(embedCalls[0]!.length, 2, "input dài phải thành hai đoạn");
  assert.ok(embedCalls[0]!.every((text) => text.startsWith("Hồ sơ dài\n\n")), "mỗi đoạn mang tiêu đề như lúc index");
  assert.deepEqual(output.matches.map((m) => m.id), ["GP-SU-CO"], "đoạn cuối quyết định kết quả, không bị đoạn đầu pha loãng");
});

test("model lỗi giữa chừng: SCORING_UNAVAILABLE, không trả kết quả một phần", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  await seed(stores, Array.from({ length: 25 }, (_, i) => job(`GP-${String(i).padStart(2, "0")}`, `Sáng kiến sự cố ${i}`, "Nội dung.")));
  const server = await startFakeServer((request, index) => (index === 1 ? { status: 500 } : fakeScoring(request)));
  try {
    await assert.rejects(
      () => checkDuplicates(input, buildDeps(stores, server.origin), options),
      (error: unknown) => error instanceof DedupError && error.code === "SCORING_UNAVAILABLE",
    );
  } finally {
    await server.close();
  }
});

test("100 ứng viên (k=100) chấm xong nhanh nhờ chạy song song", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  await seed(stores, Array.from({ length: 100 }, (_, i) => job(`GP-${String(i).padStart(3, "0")}`, `Sáng kiến ${i}`, i % 2 ? "Có sự cố." : "Không.")));
  // Mỗi lần gọi model mất 200ms: nếu tuần tự thì 10 batch = 2s, song song chỉ ~200ms.
  const server = await startFakeServer((request) => ({ ...fakeScoring(request), delayMs: 200 }));
  try {
    const startedAt = Date.now();
    const output = await checkDuplicates(input, buildDeps(stores, server.origin), options);
    const elapsed = Date.now() - startedAt;

    assert.equal(server.requests.length, 10);
    assert.equal(output.matches.length, 30, "cắt theo maxItems của schema");
    assert.ok(elapsed < 1200, `10 batch phải chạy song song, thực tế ${elapsed}ms`);
  } finally {
    await server.close();
  }
});
