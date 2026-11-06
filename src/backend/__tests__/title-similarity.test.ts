import { test } from "node:test";
import assert from "node:assert/strict";
import { createTitleSimilarity } from "../title-similarity.js";
import { EmbeddingError, createMockEmbedder, type Embedder } from "../embeddings.js";
import type { Candidate, DedupInput } from "../dedup.js";

const input: DedupInput = { type: "solutions", title: "Báo cáo sự cố mặt đất", content: "x" };

function candidate(id: string, title: string): Candidate {
  return { id, type: "solutions", title, content: "nội dung" };
}

test("một request embedding cho tiêu đề input và mọi tiêu đề ứng viên (đã bỏ trùng); cosine theo đúng thứ tự ứng viên", async () => {
  const calls: string[][] = [];
  const embed: Embedder = async (texts) => {
    calls.push(texts);
    const vectors: Record<string, number[]> = {
      "Báo cáo sự cố mặt đất": [1, 0],
      "Dữ liệu dùng chung": [0, 1],
      "Sự cố gần giống": [0.6, 0.8],
    };
    return texts.map((text) => vectors[text]!);
  };

  const result = await createTitleSimilarity(embed)(input, [
    candidate("a", "Dữ liệu dùng chung"),
    candidate("b", "Sự cố gần giống"),
    candidate("c", "Dữ liệu dùng chung"),
  ]);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["Báo cáo sự cố mặt đất", "Dữ liệu dùng chung", "Sự cố gần giống"]);
  assert.deepEqual(result, [0, 0.6, 0]);
});

test("tiêu đề y hệt nhau cho cosine 1 (embedding mock)", async () => {
  const [same, other] = await createTitleSimilarity(createMockEmbedder(32))(input, [
    candidate("a", input.title),
    candidate("b", "Nền tảng dữ liệu dùng chung"),
  ]);

  assert.ok(Math.abs(same! - 1) < 1e-9);
  assert.ok(other! < same!);
});

test("không có ứng viên thì không gọi embedder", async () => {
  let called = false;
  const result = await createTitleSimilarity(async () => {
    called = true;
    return [];
  })(input, []);

  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("embedder lỗi: ghi log chỉ có mã lỗi (không có tiêu đề) rồi ném lại để lớp trên bỏ qua gợi ý này", async () => {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const similarity = createTitleSimilarity(
    async () => {
      throw new EmbeddingError("RATE_LIMITED", "hết quota");
    },
    (event, details) => logs.push([event, details]),
  );

  await assert.rejects(
    () => similarity(input, [candidate("a", "Tiêu đề bí mật")]),
    (error: unknown) => error instanceof EmbeddingError && error.code === "RATE_LIMITED",
  );
  assert.deepEqual(logs, [["title_similarity_unavailable", { cause: "RATE_LIMITED", candidates: 1 }]]);
  assert.doesNotMatch(JSON.stringify(logs), /bí mật|Báo cáo/);
});

test("embedder trả sai số vector là BAD_RESPONSE", async () => {
  await assert.rejects(
    () => createTitleSimilarity(async () => [[1, 0]])(input, [candidate("a", "Khác")]),
    (error: unknown) => error instanceof EmbeddingError && error.code === "BAD_RESPONSE",
  );
});
