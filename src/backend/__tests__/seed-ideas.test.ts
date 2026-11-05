import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseIndexEvent } from '../index-event.js';
import { chunkText } from '../chunker.js';
import { processIndexJob } from '../index-job.js';
import { createMockEmbedder } from '../embeddings.js';
import { RECORD_TYPES } from '../record-type.js';
import { createInMemoryVectorStores } from '../vector-store.js';

/**
 * scripts/seed-ideas.json là dữ liệu mẫu cho script seed. Test này giữ cho file luôn
 * hợp lệ theo ĐÚNG luật của webhook (nếu không, seed sẽ hỏng giữa chừng khi chạy thật).
 */
const SEED_FILE = new URL('../../../scripts/seed-ideas.json', import.meta.url);

async function load(): Promise<unknown[]> {
  const raw: unknown = JSON.parse(await readFile(SEED_FILE, 'utf8'));
  assert.ok(Array.isArray(raw));
  return raw;
}

test('mọi sáng kiến mẫu qua được parseIndexEvent (cùng luật với webhook)', async () => {
  for (const item of await load()) parseIndexEvent(item);
});

test('id mẫu bắt đầu bằng SEED- và không trùng nhau', async () => {
  const events = (await load()).map((item) => parseIndexEvent(item));
  const ids = events.map((event) => event.ideaId);

  assert.ok(ids.every((id) => id.startsWith('SEED-')));
  assert.equal(new Set(ids).size, ids.length);
});

test('dữ liệu mẫu phủ đủ cả ba type (mỗi type một collection) và không dùng type nào ngoài ba giá trị', async () => {
  const types = (await load()).map((item) => parseIndexEvent(item).type);

  for (const type of RECORD_TYPES) {
    assert.ok(types.includes(type), `thiếu sáng kiến mẫu type ${type}`);
  }
  assert.ok(types.every((type) => (RECORD_TYPES as readonly string[]).includes(type)));
});

test('mỗi sáng kiến mẫu đi qua đường index thật vào đúng collection của type, không rò sang collection khác', async () => {
  const events = (await load()).map((item) => parseIndexEvent(item));
  const stores = createInMemoryVectorStores(16);

  for (const event of events) {
    await processIndexJob(
      { jobId: `seed-${event.ideaId}`, ...event, receivedAt: '2026-11-04T00:00:00.000Z' },
      { embed: createMockEmbedder(16), stores, embeddingModel: 'mock-embedding' },
    );
  }

  for (const type of RECORD_TYPES) {
    const expected = events.filter((event) => event.type === type).map((event) => event.ideaId).sort();
    const { points } = await stores.forType(type).scrollAll();
    const actual = [...new Set(points.map((point) => point.payload.ideaId))].sort();
    assert.deepEqual(actual, expected, `collection ${type}`);
    assert.ok(points.every((point) => point.payload.type === type));
  }
});

test('có cặp sinh đôi khác type (cùng nội dung, khác collection) để thử bằng tay rằng các type không lẫn nhau', async () => {
  const events = (await load()).map((item) => parseIndexEvent(item));
  const byId = new Map(events.map((event) => [event.ideaId, event]));

  const twins = events.filter((event) => typeof event.metadata.twinOf === 'string');
  assert.ok(twins.length >= 1);
  for (const twin of twins) {
    const original = byId.get(twin.metadata.twinOf as string);
    assert.ok(original, `${twin.ideaId} trỏ tới một id mẫu không tồn tại`);
    assert.notEqual(original.type, twin.type, `${twin.ideaId} phải khác type với bản gốc`);
  }
});

test('số lượng nằm dưới trần ứng viên mặc định để nạp xong vẫn kiểm tra trùng được', async () => {
  const count = (await load()).length;
  assert.ok(count >= 5 && count <= 50, `có ${count} sáng kiến mẫu`);
});

test('có ít nhất một sáng kiến nhiều chunk để thử đường gom chunk', async () => {
  const chunkCounts = (await load()).map((item) => chunkText(parseIndexEvent(item).content).length);
  assert.ok(chunkCounts.some((count) => count > 1));
});
