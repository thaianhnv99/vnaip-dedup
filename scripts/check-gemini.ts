/**
 * Kiểm tra cấu hình Gemini bằng khoá THẬT trước khi deploy. Gọi đúng code production
 * (scorer và embedding client), nên pass ở đây nghĩa là service cũng sẽ gọi được.
 *
 * Kiểm ba thứ mà tài liệu Gemini không nói rõ:
 *   1. Chat có nhận `response_format: json_object`, `max_tokens` và `reasoning_effort` không.
 *   2. Endpoint /embeddings có nhận `dimensions` (ra 1536 chiều khớp Qdrant) không; nếu không
 *      thì in số chiều mặc định thực tế.
 *   3. (tuỳ chọn) `--burst=N`: bắn N request chat song song để xem bao nhiêu bị 429, từ đó chọn
 *      LLM_SCORER_CONCURRENCY / LLM_SCORER_BATCH_SIZE cho free tier. Mỗi request tốn quota.
 *
 * Cách dùng (đọc cấu hình từ .env hoặc biến môi trường, xem .env.example):
 *   GEMINI_API_KEY=... LLM_SCORER_MODEL=gemini-2.5-flash npx tsx scripts/check-gemini.ts
 *   npx tsx scripts/check-gemini.ts --burst=10
 *
 * Chỉ in mã HTTP, tên model công khai, số chiều, thời gian và mã lỗi của app. Không bao giờ in
 * khoá API hay body phản hồi (chỉ trường `status` kiểu RESOURCE_EXHAUSTED của lỗi Google).
 * Dữ liệu gửi đi là câu mẫu cố định, không phải hồ sơ thật.
 */
import 'dotenv/config';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  EmbeddingError,
  createHttpEmbedder,
  loadEmbeddingConfig,
} from '../src/backend/embeddings.js';
import {
  LlmScorerError,
  loadLlmScorerConfig,
  scoreCandidatesWithLlm,
} from '../src/backend/llm-scorer.js';

const burstArg = process.argv.find((arg) => arg.startsWith('--burst='));
const burst = burstArg ? Number(burstArg.slice('--burst='.length)) : 0;

let failed = false;
const fail = (message: string) => {
  failed = true;
  console.log(`  ✗ ${message}`);
};
const ok = (message: string) => console.log(`  ✓ ${message}`);

/** Chỉ lấy mã trạng thái kiểu RESOURCE_EXHAUSTED của lỗi Google; bỏ phần message. */
async function googleErrorStatus(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const first = Array.isArray(body) ? body[0] : body;
    const status = (first as { error?: { status?: unknown } } | null)?.error?.status;
    return typeof status === 'string' && /^[A-Z_]{3,40}$/.test(status) ? ` (${status})` : '';
  } catch {
    return '';
  }
}

async function listModels(baseUrl: string, apiKey: string) {
  console.log('\n[1] Danh sách model');
  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  }).catch(() => undefined);
  if (!response) return fail('không kết nối được tới Gemini');
  if (!response.ok) {
    return fail(`HTTP ${response.status}${await googleErrorStatus(response)} (khoá sai hoặc chưa bật Gemini API?)`);
  }
  const body = (await response.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
  const ids = (body?.data ?? [])
    .map((item) => (typeof item.id === 'string' ? item.id.replace(/^models\//, '') : ''))
    .filter((id) => /flash|embedding/i.test(id));
  ok(`khoá hợp lệ; model flash/embedding thấy được: ${ids.slice(0, 40).join(', ') || '(không có)'}`);
}

async function checkScorer() {
  console.log('\n[2] Scorer (chat completions)');
  const config = loadLlmScorerConfig(process.env);
  console.log(
    `  model=${config.model || '(chưa đặt)'} reasoning_effort=${config.reasoningEffort ?? '(không gửi)'} ` +
      `batch=${config.batchSize} concurrency=${config.concurrency}`,
  );
  if (!config.apiKey || !config.model) {
    return fail('thiếu GEMINI_API_KEY (hoặc LLM_SCORER_API_KEY) hoặc LLM_SCORER_MODEL');
  }
  const candidates = [
    { id: 'c1', type: 'ideas' as const, title: 'Ứng dụng báo cáo sự cố', content: 'Ứng dụng cho nhân viên báo cáo sự cố mặt đất theo thời gian thực.' },
    { id: 'c2', type: 'ideas' as const, title: 'Quy trình tuyển dụng', content: 'Quy trình tuyển dụng nhân sự mới cho phòng hành chính.' },
  ];
  const startedAt = Date.now();
  try {
    const matches = await scoreCandidatesWithLlm(
      { type: 'ideas', title: 'Báo cáo sự cố bằng điện thoại', content: 'Nhân viên mặt đất gửi báo cáo sự cố ngay từ điện thoại.' },
      candidates,
      config,
      { deadlineAt: Date.now() + 25000 },
    );
    const summary = matches.map((m) => `${m.id}=${m.percent}%`).join(' ');
    ok(`${matches.length} mục chấm điểm hợp lệ trong ${Date.now() - startedAt}ms (${summary}); c1 nên cao hơn c2`);
  } catch (error) {
    if (!(error instanceof LlmScorerError)) throw error;
    const detail = error.detail ? ` detail=${JSON.stringify(error.detail)}` : '';
    fail(`${error.code}: ${error.message}${detail}`);
    if (error.code === 'BAD_OUTPUT') {
      console.log('    gợi ý: nếu reason=truncated thì đặt LLM_SCORER_REASONING_EFFORT=none (hoặc minimal) hoặc đổi sang model nhẹ hơn');
    }
  }
}

async function checkEmbedding() {
  console.log('\n[3] Embedding');
  const config = loadEmbeddingConfig(process.env);
  console.log(`  model=${config.model} dimensions=${config.dimensions}`);
  if (!config.apiKey) return fail('thiếu GEMINI_API_KEY');

  const probe = async (withDimensions: boolean) => {
    const response = await fetch(`${config.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        input: ['câu thử'],
        encoding_format: 'float',
        ...(withDimensions ? { dimensions: config.dimensions } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => undefined);
    if (!response) return 'không kết nối được';
    if (!response.ok) return `HTTP ${response.status}${await googleErrorStatus(response)}`;
    const body = (await response.json().catch(() => null)) as { data?: Array<{ embedding?: unknown[] }> } | null;
    const length = body?.data?.[0]?.embedding?.length;
    return typeof length === 'number' ? `${length} chiều` : 'response không có embedding';
  };
  console.log(`  không gửi dimensions → ${await probe(false)} (mặc định của model)`);
  console.log(`  gửi dimensions=${config.dimensions} → ${await probe(true)}`);

  try {
    const vectors = await createHttpEmbedder(config)(['Ứng dụng báo cáo sự cố', 'Quy trình tuyển dụng']);
    ok(`client production trả ${vectors.length} vector, mỗi vector ${vectors[0]!.length} chiều`);
    if (config.dimensions !== DEFAULT_EMBEDDING_DIMENSIONS) {
      console.log(`    lưu ý: EMBEDDING_DIMENSIONS=${config.dimensions} khác ${DEFAULT_EMBEDDING_DIMENSIONS} của collection Qdrant hiện có; cần QDRANT_COLLECTION_PREFIX mới và index lại`);
    }
  } catch (error) {
    if (!(error instanceof EmbeddingError)) throw error;
    fail(`${error.code}: ${error.message}`);
    console.log('    nếu dòng "gửi dimensions" không ra đúng số chiều: endpoint không nhận `dimensions`, cần đổi cách gọi (báo lại kết quả này).');
  }
}

async function checkBurst(count: number) {
  console.log(`\n[4] Burst ${count} request chat song song`);
  const config = loadLlmScorerConfig(process.env);
  if (!config.apiKey || !config.model) return fail('thiếu khoá hoặc LLM_SCORER_MODEL');
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: count }, async () => {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Trả lời một từ: ok' }],
          ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        }),
        signal: AbortSignal.timeout(25000),
      }).catch(() => undefined);
      void response?.body?.cancel().catch(() => undefined);
      return response?.status ?? 0;
    }),
  );
  const histogram = new Map<number, number>();
  for (const status of results) histogram.set(status, (histogram.get(status) ?? 0) + 1);
  const text = [...histogram].map(([status, n]) => `${status === 0 ? 'lỗi mạng' : `HTTP ${status}`}: ${n}`).join(', ');
  (histogram.size === 1 && histogram.has(200) ? ok : fail)(`${text} trong ${Date.now() - startedAt}ms`);
  if (histogram.has(429)) {
    console.log('    có 429: giảm LLM_SCORER_CONCURRENCY xuống ≤ số request thành công ở trên, và tăng LLM_SCORER_BATCH_SIZE để mỗi lần check dùng ít request hơn');
  }
}

async function main() {
  const embedding = loadEmbeddingConfig(process.env);
  console.log(`Gemini base URL: ${embedding.baseUrl}`);
  if (embedding.apiKey) await listModels(embedding.baseUrl, embedding.apiKey);
  else {
    console.log('\n[1] Danh sách model');
    fail('thiếu GEMINI_API_KEY');
  }
  await checkScorer();
  await checkEmbedding();
  if (Number.isInteger(burst) && burst > 0) await checkBurst(burst);

  console.log(failed ? '\nCó bước thất bại, chưa nên deploy.' : '\nTất cả bước đều pass.');
  process.exitCode = failed ? 1 : 0;
}

await main();
