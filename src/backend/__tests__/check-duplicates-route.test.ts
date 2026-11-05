import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDependencies, createCheckDuplicatesHandler } from '../check-duplicates-route.js';
import type { DedupDependencies } from '../dedup.js';
import type { Request, Response } from 'express';
import { LlmScorerError } from '../llm-scorer.js';
import { VectorStoreError, pointId } from '../vector-store.js';
import { createVectorStoresFromEnv } from '../qdrant-store.js';
import { DEFAULT_EMBEDDING_DIMENSIONS } from '../embeddings.js';
import { DedupError } from '../dedup.js';

function fakeRequestResponse(body: unknown) {
  const request = {
    body,
    header: () => undefined,
  } as unknown as Request;

  const state: { status: number; body?: unknown } = { status: 200 };
  const response = {
    locals: { sota: { oid: 'org-1', wid: 'ws-1', iid: 'install-1', sub: 'user-1', scp: ['tool:check-duplicates'] } },
    getHeader: () => 'req-1',
    status(code: number) {
      state.status = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
  } as unknown as Response;

  return { request, response, state };
}

const validInput = {
  type: 'solutions',
  title: 'Giải pháp quản lý hồ sơ',
  content: 'Nội dung mô tả giải pháp quản lý hồ sơ số hóa cho đơn vị hành chính.',
};

test('request hợp lệ trả 200 với output đúng schema', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => [{ id: 'a', type: 'solutions', title: 'A', content: 'nội dung A' }],
    scoreCandidates: async () => [{ id: 'a', percent: 60, reason: 'giống nhau' }],
  };

  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 200);
  assert.deepEqual((state.body as any).matches[0].id, 'a');
  assert.equal((state.body as any).matches[0].percent, 60);
  assert.equal((state.body as any).matches[0].score, 0.6);
});

test('input sai schema trả 400 INVALID_INPUT', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => [],
    scoreCandidates: async () => [],
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: { type: 'solutions' } } });

  await handler(request, response, () => {});

  assert.equal(state.status, 400);
  assert.equal((state.body as any).code, 'INVALID_INPUT');
  assert.equal((state.body as any).requestId, 'req-1');
});

test('nguồn ứng viên lỗi trả 502 CANDIDATES_UNAVAILABLE, không lộ chi tiết lỗi gốc', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => {
      throw new Error('ECONNREFUSED 10.0.0.5:443 token=super-secret-abc');
    },
    scoreCandidates: async () => [],
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 502);
  assert.equal((state.body as any).code, 'CANDIDATES_UNAVAILABLE');
  assert.equal((state.body as any).requestId, 'req-1');
  assert.doesNotMatch(JSON.stringify(state.body), /super-secret-abc/);
  assert.doesNotMatch(JSON.stringify(state.body), /10\.0\.0\.5/);
});

test('lỗi lấy ứng viên không kèm cause/detail trong body (chỉ lỗi chấm điểm mới có)', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => {
      throw new VectorStoreError('TIMEOUT', 'Gọi Qdrant quá thời gian cho phép');
    },
    scoreCandidates: async () => [],
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 502);
  assert.equal((state.body as any).code, 'CANDIDATES_UNAVAILABLE');
  assert.equal('cause' in (state.body as object), false);
  assert.equal('detail' in (state.body as object), false);
});

test('model lỗi trả 502 SCORING_UNAVAILABLE', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => [{ id: 'a', type: 'solutions', title: 'A', content: 'x' }],
    scoreCandidates: async () => {
      throw new Error('provider 500');
    },
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 502);
  assert.equal((state.body as any).code, 'SCORING_UNAVAILABLE');
  assert.equal((state.body as any).requestId, 'req-1');
  // Lỗi gốc không phải LlmScorerError thì không có gì an toàn để nêu: không cause/detail.
  assert.equal('cause' in (state.body as object), false);
  assert.equal('detail' in (state.body as object), false);
});

test('output model bị cắt: body nêu cause BAD_OUTPUT và detail đã lọc, không lộ nội dung model', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => [{ id: 'a', type: 'solutions', title: 'A', content: 'x' }],
    scoreCandidates: async () => {
      throw new LlmScorerError('BAD_OUTPUT', 'Output của model bị cắt vì hết giới hạn token (max_tokens)', {
        detail: {
          reason: 'truncated',
          finishReason: 'length',
          contentLength: 371,
          contentHead: 'BÍ MẬT XYZ-123',
          topLevelKeys: ['BÍ MẬT XYZ-123'],
        },
      });
    },
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 502);
  assert.deepEqual(state.body, {
    code: 'SCORING_UNAVAILABLE',
    message: 'Model chấm điểm tương đồng thất bại. Vui lòng thử lại sau.',
    requestId: 'req-1',
    cause: 'BAD_OUTPUT',
    detail: { reason: 'truncated', finishReason: 'length', contentLength: 371 },
  });
  assert.doesNotMatch(JSON.stringify(state.body), /BÍ MẬT|XYZ-123/);
});

test('lỗi chấm điểm không có detail: body có cause nhưng không có field detail', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => [{ id: 'a', type: 'solutions', title: 'A', content: 'x' }],
    scoreCandidates: async () => {
      throw new LlmScorerError('TIMEOUT', 'Model chấm điểm quá thời gian cho phép');
    },
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal((state.body as any).cause, 'TIMEOUT');
  assert.equal('detail' in (state.body as object), false);
});

test('code thô của thư viện/Node (ECONNREFUSED...) không bao giờ vào cause của body', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => [{ id: 'a', type: 'solutions', title: 'A', content: 'x' }],
    scoreCandidates: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED' });
    },
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal((state.body as any).code, 'SCORING_UNAVAILABLE');
  assert.equal('cause' in (state.body as object), false);
  assert.doesNotMatch(JSON.stringify(state.body), /ECONNREFUSED|10\.0\.0\.5/);
});

test('NOT_CONFIGURED của scorer không lộ qua cause dù bị bọc trong SCORING_UNAVAILABLE', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => [{ id: 'a', type: 'solutions', title: 'A', content: 'x' }],
    scoreCandidates: async () => {
      throw new LlmScorerError('NOT_CONFIGURED', 'thiếu GEMINI_API_KEY hoặc LLM_SCORER_MODEL');
    },
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal((state.body as any).code, 'SCORING_UNAVAILABLE');
  assert.equal('cause' in (state.body as object), false);
  assert.doesNotMatch(JSON.stringify(state.body), /GEMINI|LLM_SCORER/);
});

test('không có ứng viên trả 200 với matches rỗng (phân biệt với lỗi)', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => [],
    scoreCandidates: async () => {
      throw new Error('không nên được gọi khi không có ứng viên');
    },
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 200);
  assert.deepEqual((state.body as any).matches, []);
});

test('log lỗi không chứa nội dung hồ sơ (title/content) hoặc bí mật', async () => {
  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };

  try {
    const deps: DedupDependencies = {
      findCandidates: async () => {
        throw new Error('network down, Authorization: Bearer abc.def.ghi');
      },
      scoreCandidates: async () => [],
    };
    const handler = createCheckDuplicatesHandler(deps, {});
    const sensitiveInput = {
      ...validInput,
      content: 'NỘI DUNG NHẠY CẢM KHÔNG ĐƯỢC LOG: mã số bí mật XYZ-123',
    };
    const { request, response } = fakeRequestResponse({ body: { input: sensitiveInput } });

    await handler(request, response, () => {});
  } finally {
    console.log = originalLog;
  }

  const combined = logged.join('\n');
  assert.doesNotMatch(combined, /NỘI DUNG NHẠY CẢM/);
  assert.doesNotMatch(combined, /XYZ-123/);
  assert.doesNotMatch(combined, /Bearer abc\.def\.ghi/);
});

function captureLog() {
  const lines: Array<Record<string, unknown>> = [];
  return {
    lines,
    log: (level: string, event: string, details: Record<string, unknown>) => {
      lines.push({ level, event, ...details });
    },
  };
}

test('trần ứng viên vượt quá trả 503 CANDIDATE_LIMIT_EXCEEDED thay vì kết quả thiếu', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () =>
      Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, type: 'solutions' as const, title: 't', content: 'c' })),
    scoreCandidates: async () => {
      throw new Error('không nên được gọi');
    },
  };
  const handler = createCheckDuplicatesHandler(deps, { CHECK_DUPLICATES_CANDIDATE_LIMIT: '2' });
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 503);
  assert.equal((state.body as any).code, 'CANDIDATE_LIMIT_EXCEEDED');
});

test('nguồn ứng viên báo vượt giới hạn đọc (DedupError) cũng trả 503, không phải 502', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => {
      throw new DedupError('CANDIDATE_LIMIT_EXCEEDED', 'kho quá lớn');
    },
    scoreCandidates: async () => [],
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 503);
  assert.equal((state.body as any).code, 'CANDIDATE_LIMIT_EXCEEDED');
});

test('giá trị CHECK_DUPLICATES_CANDIDATE_LIMIT không hợp lệ rơi về mặc định 100, không tắt giới hạn', async () => {
  const candidates = Array.from({ length: 101 }, (_, i) => ({
    id: `c${i}`,
    type: 'solutions' as const,
    title: 't',
    content: 'c',
  }));
  for (const raw of ['0', '-5', 'abc', '501', '1.5', '']) {
    const handler = createCheckDuplicatesHandler(
      { findCandidates: async () => candidates, scoreCandidates: async () => [] },
      { CHECK_DUPLICATES_CANDIDATE_LIMIT: raw },
    );
    const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });
    await handler(request, response, () => {});
    assert.equal(state.status, 503, `giá trị ${JSON.stringify(raw)} phải rơi về mặc định 100`);
  }
});

test('thiếu cấu hình trả 503 TOOL_NOT_CONFIGURED, và lần gọi sau chạy được khi đã sửa cấu hình', async () => {
  const { lines, log } = captureLog();
  let configured = false;
  let built = 0;
  const handler = createCheckDuplicatesHandler(
    () => {
      built += 1;
      if (!configured) {
        throw new VectorStoreError('NOT_CONFIGURED', 'Qdrant chưa được cấu hình (thiếu QDRANT_URL hoặc QDRANT_COLLECTION_PREFIX)');
      }
      return {
        findCandidates: async () => [{ id: 'a', type: 'solutions', title: 'A', content: 'x' }],
        scoreCandidates: async () => [{ id: 'a', percent: 40, reason: 'ok' }],
      };
    },
    {},
    log,
  );

  const first = fakeRequestResponse({ body: { input: validInput } });
  await handler(first.request, first.response, () => {});
  assert.equal(first.state.status, 503);
  assert.equal((first.state.body as any).code, 'TOOL_NOT_CONFIGURED');
  // Body trả cho caller không nêu tên biến môi trường; log thì có để người vận hành sửa.
  assert.doesNotMatch(JSON.stringify(first.state.body), /QDRANT/);
  assert.match(String(lines.find((l) => l.event === 'check_duplicates_failed')?.message), /QDRANT_URL/);

  configured = true;
  const second = fakeRequestResponse({ body: { input: validInput } });
  await handler(second.request, second.response, () => {});
  assert.equal(second.state.status, 200);

  // Dựng thành công thì được nhớ lại, không dựng lại mỗi request.
  const third = fakeRequestResponse({ body: { input: validInput } });
  await handler(third.request, third.response, () => {});
  assert.equal(built, 2);
});

test('scorer chưa cấu hình (LlmScorerError NOT_CONFIGURED) cũng trả 503 TOOL_NOT_CONFIGURED', async () => {
  const handler = createCheckDuplicatesHandler(() => {
    throw new LlmScorerError('NOT_CONFIGURED', 'LLM scorer chưa được cấu hình');
  }, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 503);
  assert.equal((state.body as any).code, 'TOOL_NOT_CONFIGURED');
});

test('log thành công và thất bại ghi mã, số lượng, thời gian; không ghi nội dung hồ sơ', async () => {
  const { lines, log } = captureLog();
  const ok = createCheckDuplicatesHandler(
    {
      findCandidates: async () => [{ id: 'a', type: 'solutions', title: 'TIÊU ĐỀ BÍ MẬT', content: 'NỘI DUNG BÍ MẬT' }],
      scoreCandidates: async () => [{ id: 'a', percent: 60, reason: 'LÝ DO BÍ MẬT' }],
    },
    {},
    log,
  );
  const good = fakeRequestResponse({ body: { input: { ...validInput, content: 'INPUT BÍ MẬT' } } });
  await ok(good.request, good.response, () => {});

  const failing = createCheckDuplicatesHandler(
    {
      findCandidates: async () => {
        throw new VectorStoreError('TIMEOUT', 'Gọi Qdrant quá thời gian cho phép');
      },
      scoreCandidates: async () => [],
    },
    {},
    log,
  );
  const bad = fakeRequestResponse({ body: { input: validInput } });
  await failing(bad.request, bad.response, () => {});

  const done = lines.find((l) => l.event === 'check_duplicates_done');
  assert.equal(done?.matches, 1);
  assert.equal(typeof done?.durationMs, 'number');
  const failed = lines.find((l) => l.event === 'check_duplicates_failed');
  assert.equal(failed?.code, 'CANDIDATES_UNAVAILABLE');
  assert.equal(failed?.cause, 'TIMEOUT');
  assert.doesNotMatch(JSON.stringify(lines), /BÍ MẬT/);
});

test('log lỗi chỉ ghi các field detail trong allow-list, đúng kiểu và bị cắt độ dài', async () => {
  const { lines, log } = captureLog();
  const handler = createCheckDuplicatesHandler(
    {
      findCandidates: async () => [{ id: 'a', type: 'solutions', title: 'A', content: 'x' }],
      scoreCandidates: async () => {
        throw new LlmScorerError('BAD_OUTPUT', 'Model trả JSON sai định dạng', {
          detail: {
            reason: 'invalid_json',
            contentLength: 42,
            finishReason: 'stop'.padEnd(500, 'x'),
            jsonType: { BÍ_MẬT: 'object' },
            topLevelKeyCount: Number.NaN,
            expectedCount: 5,
            scoredCount: 3,
            contentHead: 'BÍ MẬT XYZ-123',
            topLevelKeys: ['BÍ MẬT XYZ-123'],
          },
        });
      },
    },
    {},
    log,
  );
  const { request, response } = fakeRequestResponse({ body: { input: validInput } });
  await handler(request, response, () => {});

  const failed = lines.find((l) => l.event === 'check_duplicates_failed');
  assert.equal(failed?.code, 'SCORING_UNAVAILABLE');
  assert.equal(failed?.cause, 'BAD_OUTPUT');
  assert.deepEqual(failed?.detail, {
    reason: 'invalid_json',
    finishReason: 'stop'.padEnd(64, 'x'),
    contentLength: 42,
    expectedCount: 5,
    scoredCount: 3,
  });
  assert.doesNotMatch(JSON.stringify(lines), /BÍ MẬT|BÍ_MẬT|XYZ-123/);
});

test('log lỗi không có field detail khi lỗi gốc không kèm detail hợp lệ', async () => {
  const { lines, log } = captureLog();
  const handler = createCheckDuplicatesHandler(
    {
      findCandidates: async () => [{ id: 'a', type: 'solutions', title: 'A', content: 'x' }],
      scoreCandidates: async () => {
        throw new LlmScorerError('BAD_OUTPUT', 'x', { detail: { contentHead: 'BÍ MẬT' } });
      },
    },
    {},
    log,
  );
  const { request, response } = fakeRequestResponse({ body: { input: validInput } });
  await handler(request, response, () => {});

  const failed = lines.find((l) => l.event === 'check_duplicates_failed');
  assert.equal('detail' in (failed ?? {}), false);
});

test('buildDependencies: thiếu cấu hình Qdrant ném NOT_CONFIGURED (không âm thầm dùng dữ liệu giả)', () => {
  assert.throws(
    () => buildDependencies({ LLM_MOCK_MODE: 'true' }),
    (error: unknown) => error instanceof VectorStoreError && error.code === 'NOT_CONFIGURED',
  );
});

test('buildDependencies: thiếu khoá/model chấm điểm ném NOT_CONFIGURED, kể cả khi LLM_MOCK_MODE không đặt', () => {
  assert.throws(
    () => buildDependencies({ QDRANT_MOCK_MODE: 'true' }),
    (error: unknown) => error instanceof LlmScorerError && error.code === 'NOT_CONFIGURED',
  );
});

test('buildDependencies: QDRANT_MOCK_MODE + LLM_MOCK_MODE chạy được và kho rỗng thì không có ứng viên', async () => {
  const deps = buildDependencies({ QDRANT_MOCK_MODE: 'true', LLM_MOCK_MODE: 'true' }, () => {});
  assert.deepEqual(await deps.findCandidates({ type: 'solutions', title: 't', content: 'c' }), []);
});

// --- type: ba collection riêng ---

test('type ngoài ideas/solutions/initiatives trả 400 INVALID_INPUT và không đụng tới nguồn ứng viên hay model', async () => {
  let touched = 0;
  const deps: DedupDependencies = {
    findCandidates: async () => {
      touched += 1;
      return [];
    },
    scoreCandidates: async () => {
      touched += 1;
      return [];
    },
  };
  const handler = createCheckDuplicatesHandler(deps, {});

  for (const type of ['solution', 'idea', 'initiative', 'project', 'other', 'Ideas', '', undefined, 7]) {
    const { request, response, state } = fakeRequestResponse({ body: { input: { ...validInput, type } } });
    await handler(request, response, () => {});
    assert.equal(state.status, 400, `type ${JSON.stringify(type)}`);
    assert.equal((state.body as any).code, 'INVALID_INPUT');
  }
  assert.equal(touched, 0);
});

test('buildDependencies: mỗi type chỉ thấy dữ liệu trong collection của chính nó (kho dùng chung với worker inline)', async () => {
  const dimensions = DEFAULT_EMBEDDING_DIMENSIONS;
  const env = { QDRANT_MOCK_MODE: 'true', LLM_MOCK_MODE: 'true' };
  const deps = buildDependencies(env, () => {});

  // Ghi như worker: qua đúng kho theo type của bộ ba kho mock dùng chung trong tiến trình.
  const stores = createVectorStoresFromEnv(env, dimensions);
  for (const type of ['ideas', 'initiatives'] as const) {
    await stores.forType(type).upsertChunks([
      {
        id: pointId(`ROUTE-${type}`, 0),
        vector: new Array(dimensions).fill(0.1),
        payload: {
          ideaId: `ROUTE-${type}`,
          type,
          title: `Tiêu đề ${type}`,
          chunkIndex: 0,
          chunkCount: 1,
          content: 'Báo cáo sự cố.',
          metadata: {},
          embeddingModel: 'mock-embedding',
          indexedAt: '2026-11-04T00:00:00.000Z',
        },
      },
    ]);
  }

  const idsFor = async (type: 'ideas' | 'solutions' | 'initiatives') =>
    (await deps.findCandidates({ type, title: 't', content: 'c' })).map((candidate) => candidate.id);
  assert.deepEqual(await idsFor('ideas'), ['ROUTE-ideas']);
  assert.deepEqual(await idsFor('initiatives'), ['ROUTE-initiatives']);
  assert.deepEqual(await idsFor('solutions'), [], 'solutions chưa có gì: không được thấy ideas hay initiatives');
});
