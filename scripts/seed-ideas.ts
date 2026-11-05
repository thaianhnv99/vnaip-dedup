/**
 * Nạp (hoặc xoá) sáng kiến mẫu vào Qdrant để phát triển và thử luồng kiểm tra
 * trùng mà không phải chờ VNAIP BE gửi webhook thật. Đi qua đúng đường index của
 * worker (`parseIndexEvent` rồi `processIndexJob`), nên dữ liệu giống hệt dữ liệu
 * webhook tạo ra.
 *
 *   npx tsx scripts/seed-ideas.ts --collection-prefix vnaip_dedup_dev           # nạp
 *   npx tsx scripts/seed-ideas.ts --collection-prefix vnaip_dedup_dev --clean   # xoá
 *
 * Mô hình dữ liệu: ba collection riêng theo type, `<prefix>_ideas`,
 * `<prefix>_solutions`, `<prefix>_initiatives`. Mỗi sáng kiến mẫu được nạp vào
 * collection của ĐÚNG `type` ghi trong scripts/seed-ideas.json, và `--clean` xoá nó
 * khỏi đúng collection đó.
 *
 * Cấu hình đọc từ .env như server: QDRANT_URL, QDRANT_COLLECTION_PREFIX (Qdrant local
 * bằng Docker không cần API key), và GEMINI_API_KEY (hoặc EMBEDDING_MOCK_MODE=true:
 * hướng A không dùng vector khi truy vấn nên vector giả đủ để thử luồng kiểm tra trùng).
 *
 * An toàn:
 * - `--collection-prefix` bắt buộc và phải TRÙNG `QDRANT_COLLECTION_PREFIX`: chống nạp
 *   nhầm vào bộ collection khác vì quên đổi .env.
 * - Từ chối prefix có chữ "prod" (nên mọi collection dẫn xuất cũng không có): dữ liệu
 *   mẫu giả sẽ hiện ra như sáng kiến thật trong kết quả kiểm tra trùng.
 * - Mọi id mẫu bắt đầu bằng `SEED-`; `--clean` chỉ xoá đúng các id trong
 *   scripts/seed-ideas.json, không xoá gì khác.
 * - Từ chối QDRANT_MOCK_MODE=true: kho trong bộ nhớ mất ngay khi script thoát.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseIndexEvent } from '../src/backend/index-event.js';
import { processIndexJob, type IndexJob } from '../src/backend/index-job.js';
import { createEmbedderFromEnv, loadEmbeddingConfig } from '../src/backend/embeddings.js';
import { createVectorStoresFromEnv, loadQdrantConfig } from '../src/backend/qdrant-store.js';
import { RECORD_TYPES, type RecordType } from '../src/backend/record-type.js';
import { lazyEnsureCollections } from '../src/backend/vector-store.js';

const SEED_FILE = fileURLToPath(new URL('./seed-ideas.json', import.meta.url));
const SEED_PREFIX = 'SEED-';

async function loadSeedIdeas(): Promise<IndexJob[]> {
  const raw: unknown = JSON.parse(await readFile(SEED_FILE, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('seed-ideas.json phải là một mảng');

  const seen = new Set<string>();
  return raw.map((item, position) => {
    const event = parseIndexEvent(item); // cùng luật với webhook, kể cả type phải là một trong 3 giá trị
    if (!event.ideaId.startsWith(SEED_PREFIX)) {
      throw new Error(`Mục ${position}: id phải bắt đầu bằng "${SEED_PREFIX}"`);
    }
    if (seen.has(event.ideaId)) throw new Error(`Mục ${position}: id bị trùng`);
    seen.add(event.ideaId);
    return {
      jobId: `seed-${event.ideaId}`,
      ideaId: event.ideaId,
      type: event.type,
      title: event.title,
      content: event.content,
      metadata: event.metadata,
      receivedAt: new Date().toISOString(),
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const clean = args.includes('--clean');
  const flagAt = args.indexOf('--collection-prefix');
  const requested = flagAt >= 0 ? args[flagAt + 1] : undefined;
  const prefix = process.env.QDRANT_COLLECTION_PREFIX;

  if (process.env.QDRANT_MOCK_MODE === 'true') {
    fail('QDRANT_MOCK_MODE=true dùng kho trong bộ nhớ, dữ liệu mất ngay khi script thoát. Đặt QDRANT_MOCK_MODE=false (hoặc bỏ) và cấu hình Qdrant thật.');
  }
  if (!requested) {
    // --collection là cờ của bản một-collection (đã bỏ): nhắc để khỏi tưởng nó còn hiệu lực.
    const hint = args.includes('--collection') ? ' (--collection đã được thay bằng --collection-prefix vì giờ mỗi type một collection)' : '';
    fail(`Thiếu --collection-prefix <tiền tố>${hint}. Ví dụ: npx tsx scripts/seed-ideas.ts --collection-prefix ${prefix || 'vnaip_dedup_dev'}`);
  }
  if (requested !== prefix) {
    fail(`--collection-prefix "${requested}" không khớp QDRANT_COLLECTION_PREFIX trong môi trường ("${prefix ?? ''}"). Sửa .env hoặc tên truyền vào để chắc chắn nạp đúng nơi.`);
  }
  if (/prod/i.test(requested)) {
    fail(`Từ chối prefix "${requested}": dữ liệu mẫu giả không được nạp vào môi trường production.`);
  }

  const ideas = await loadSeedIdeas();
  const embeddingConfig = loadEmbeddingConfig();
  const mockEmbedding = process.env.EMBEDDING_MOCK_MODE === 'true';
  const collections = loadQdrantConfig(process.env, embeddingConfig.dimensions).collections;
  const stores = createVectorStoresFromEnv(process.env, embeddingConfig.dimensions);
  const ensureReady = lazyEnsureCollections(stores);
  // Tạo đủ cả ba collection, kể cả type không có sáng kiến mẫu nào.
  for (const type of RECORD_TYPES) await ensureReady(type);

  if (clean) {
    // Mỗi sáng kiến chỉ bị xoá khỏi collection của chính type của nó.
    for (const idea of ideas) await stores.forType(idea.type).deleteIdea(idea.ideaId);
    for (const type of RECORD_TYPES) {
      console.log(`  ${collections[type]}: đã xoá ${ideas.filter((idea) => idea.type === type).length} sáng kiến mẫu`);
    }
    console.log(`Đã xoá ${ideas.length} sáng kiến mẫu khỏi ${RECORD_TYPES.length} collection (tiền tố "${requested}").`);
    return;
  }

  const embed = createEmbedderFromEnv();
  const chunksByType = new Map<RecordType, number>();
  const ideasByType = new Map<RecordType, number>();
  let chunks = 0;
  for (const idea of ideas) {
    const result = await processIndexJob(idea, {
      embed,
      stores,
      // Gắn nhãn đúng để sau này biết vector nào là giả (cần reindex khi chuyển sang hướng B).
      embeddingModel: mockEmbedding ? 'mock-embedding' : embeddingConfig.model,
    });
    chunks += result.chunks;
    chunksByType.set(idea.type, (chunksByType.get(idea.type) ?? 0) + result.chunks);
    ideasByType.set(idea.type, (ideasByType.get(idea.type) ?? 0) + 1);
    console.log(`  ${collections[idea.type]}: ${idea.ideaId}: ${result.chunks} chunk`);
  }
  for (const type of RECORD_TYPES) {
    console.log(`  ${collections[type]}: ${ideasByType.get(type) ?? 0} sáng kiến, ${chunksByType.get(type) ?? 0} chunk`);
  }
  console.log(
    `Đã nạp ${ideas.length} sáng kiến mẫu (${chunks} chunk) vào ${RECORD_TYPES.length} collection (tiền tố "${requested}")` +
      `${mockEmbedding ? ' với vector GIẢ' : ''}. Xoá bằng --clean.`,
  );
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((error) => {
  // Chỉ in tên và mã lỗi: thông báo từ thư viện có thể chứa chi tiết không muốn lộ.
  console.error('Seed thất bại:', error instanceof Error ? error.name : 'unknown', (error as { code?: string })?.code ?? '');
  process.exit(1);
});
