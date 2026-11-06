import { test } from "node:test";
import assert from "node:assert/strict";
import { createInputEmbedder } from "../input-embedder.js";
import { EmbeddingError, embeddingText, type Embedder } from "../embeddings.js";
import { chunkText } from "../chunker.js";
import type { DedupInput } from "../dedup.js";

const input = (content: string, title = "Tiêu đề hồ sơ"): DedupInput => ({ type: "solutions", title, content });

function recordingEmbedder() {
  const calls: string[][] = [];
  const embed: Embedder = async (texts) => {
    calls.push(texts);
    return texts.map((_, i) => [i, 1]);
  };
  return { calls, embed };
}

test("hồ sơ ngắn: một đoạn, embed 'tiêu đề + nội dung' trong một request", async () => {
  const { calls, embed } = recordingEmbedder();

  const vectors = await createInputEmbedder(embed)(input("Nội dung ngắn."));

  assert.deepEqual(calls, [[embeddingText("Tiêu đề hồ sơ", "Nội dung ngắn.")]]);
  assert.deepEqual(vectors, [[0, 1]]);
});

test("văn bản embed đúng định dạng của luồng index (tiêu đề, dòng trống, đoạn)", async () => {
  const { calls, embed } = recordingEmbedder();

  await createInputEmbedder(embed)(input("Đoạn một."));

  assert.equal(calls[0]![0], "Tiêu đề hồ sơ\n\nĐoạn một.");
});

test("hồ sơ dài: chia đoạn bằng chunkText như lúc index, mọi đoạn trong MỘT request, đúng thứ tự", async () => {
  const content = Array.from({ length: 6 }, (_, i) => `Đoạn số ${i + 1}: ${"nội dung ".repeat(10).trim()}.`).join("\n\n");
  const { calls, embed } = recordingEmbedder();

  const vectors = await createInputEmbedder(embed, { chunkChars: 150 })(input(content));

  const expected = chunkText(content, { maxChars: 150 });
  assert.ok(expected.length > 1, "phải nhiều hơn một đoạn");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], expected.map((chunk) => embeddingText("Tiêu đề hồ sơ", chunk)));
  assert.equal(vectors.length, expected.length);
});

test("lỗi của embedder được giữ nguyên (EmbeddingError), không bị đổi thành kết quả rỗng", async () => {
  const embed: Embedder = async () => {
    throw new EmbeddingError("RATE_LIMITED", "hết quota");
  };

  await assert.rejects(
    () => createInputEmbedder(embed)(input("Nội dung.")),
    (error: unknown) => error instanceof EmbeddingError && error.code === "RATE_LIMITED",
  );
});

test("embedder trả sai số vector thì báo BAD_RESPONSE thay vì tìm với truy vấn thiếu", async () => {
  const embed: Embedder = async () => [];

  await assert.rejects(
    () => createInputEmbedder(embed)(input("Nội dung.")),
    (error: unknown) => error instanceof EmbeddingError && error.code === "BAD_RESPONSE",
  );
});

test("nội dung chỉ có khoảng trắng: INVALID_INPUT và không gọi embedder", async () => {
  const { calls, embed } = recordingEmbedder();

  await assert.rejects(
    () => createInputEmbedder(embed)(input("   \n\n  ")),
    (error: unknown) => error instanceof EmbeddingError && error.code === "INVALID_INPUT",
  );
  assert.equal(calls.length, 0);
});
