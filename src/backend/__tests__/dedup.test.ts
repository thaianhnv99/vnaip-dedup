import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDuplicates,
  DedupError,
  type Candidate,
  type DedupDependencies,
  type RawModelMatch,
} from '../dedup.js';

const options = { topK: 30, deadlineMs: 5000 };

const validInput = {
  type: 'solutions' as const,
  title: 'Giải pháp quản lý hồ sơ',
  content: 'Nội dung mô tả giải pháp quản lý hồ sơ số hóa.',
};

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return { id, type: 'solutions', title: `Candidate ${id}`, content: `Nội dung của ${id}`, ...overrides };
}

function deps(overrides: Partial<DedupDependencies>): DedupDependencies {
  return {
    embedInput: async () => [[1, 0]],
    findCandidates: async () => [],
    scoreCandidates: async () => [],
    ...overrides,
  };
}

test('input hợp lệ với candidate và percent hợp lệ trả về matches đã sort giảm dần, score suy ra từ percent', async () => {
  const candidates = [candidate('a'), candidate('b')];
  const matches: RawModelMatch[] = [
    { id: 'a', percent: 40, reason: 'thấp' },
    { id: 'b', percent: 90, reason: 'cao' },
  ];

  const output = await checkDuplicates(
    validInput,
        deps({
      findCandidates: async () => candidates,
      scoreCandidates: async () => matches,
    }),
    options,
  );

  assert.deepEqual(output.matches.map((m) => m.id), ['b', 'a']);
  assert.equal(output.matches[0].percent, 90);
  assert.equal(output.matches[0].score, 0.9);
  assert.equal(output.matches[1].percent, 40);
  assert.equal(output.matches[1].score, 0.4);
});

test('type ngoài ideas/solutions/initiatives bị từ chối INVALID_INPUT và không đụng tới embedding, nguồn ứng viên hay model', async () => {
  let touched = 0;
  const spy = deps({
    embedInput: async () => {
      touched += 1;
      return [[1, 0]];
    },
    findCandidates: async () => {
      touched += 1;
      return [];
    },
    scoreCandidates: async () => {
      touched += 1;
      return [];
    },
  });
  for (const type of ['solution', 'idea', 'project', 'other', 'Ideas', '', undefined]) {
    await assert.rejects(
      () => checkDuplicates({ ...validInput, type: type as never }, spy, options),
      (error: unknown) => error instanceof DedupError && error.code === 'INVALID_INPUT',
      `type ${JSON.stringify(type)}`,
    );
  }
  assert.equal(touched, 0);
});

test('kết quả mang type của chính input, với cả ba type', async () => {
  for (const type of ['ideas', 'solutions', 'initiatives'] as const) {
    const output = await checkDuplicates(
      { ...validInput, type },
      deps({
        findCandidates: async () => [candidate('a', { type })],
        scoreCandidates: async () => [{ id: 'a', percent: 70, reason: 'giống' }],
      }),
      options,
    );
    assert.deepEqual(output.matches.map((m) => [m.id, m.type]), [['a', type]]);
  }
});

test('nguồn ứng viên trả sáng kiến khác type với input thì fail closed (CANDIDATES_UNAVAILABLE), không so sánh chéo type', async () => {
  let scored = 0;
  await assert.rejects(
    () =>
      checkDuplicates(
        { ...validInput, type: 'solutions' },
        deps({
          // Một ứng viên đúng type lẫn với một ứng viên của collection khác.
          findCandidates: async () => [candidate('a', { type: 'solutions' }), candidate('b', { type: 'ideas' })],
          scoreCandidates: async () => {
            scored += 1;
            return [{ id: 'b', percent: 99, reason: 'khác type' }];
          },
        }),
        options,
      ),
    (error: unknown) => error instanceof DedupError && error.code === 'CANDIDATES_UNAVAILABLE',
  );
  assert.equal(scored, 0, 'không được gửi ứng viên khác type cho model');
});

test('input thiếu title bị từ chối với DedupError INVALID_INPUT', async () => {
  await assert.rejects(
    () =>
      checkDuplicates(
        { ...validInput, title: '  ' },
                deps({}),
        options,
      ),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, 'INVALID_INPUT');
      return true;
    },
  );
});

test('input thiếu content bị từ chối', async () => {
  await assert.rejects(() =>
    checkDuplicates({ ...validInput, content: '' }, deps({}), options),
  );
});

test('không có ứng viên trả về matches rỗng (không phải lỗi)', async () => {
  const output = await checkDuplicates(
    validInput,
        deps({ findCandidates: async () => [] }),
    options,
  );
  assert.deepEqual(output.matches, []);
});

test('VNAIP BE lỗi khi lấy ứng viên: propagate CANDIDATES_UNAVAILABLE, KHÔNG trả matches rỗng im lặng', async () => {
  await assert.rejects(
    () =>
      checkDuplicates(
        validInput,
                deps({
          findCandidates: async () => {
            throw new Error('network down');
          },
        }),
        options,
      ),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, 'CANDIDATES_UNAVAILABLE');
      return true;
    },
  );
});

test('model lỗi khi chấm điểm: propagate SCORING_UNAVAILABLE', async () => {
  await assert.rejects(
    () =>
      checkDuplicates(
        validInput,
                deps({
          findCandidates: async () => [candidate('a')],
          scoreCandidates: async () => {
            throw new Error('provider timeout');
          },
        }),
        options,
      ),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, 'SCORING_UNAVAILABLE');
      return true;
    },
  );
});

test('model trả ID không thuộc danh sách ứng viên: bị loại khỏi kết quả', async () => {
  const output = await checkDuplicates(
    validInput,
        deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async () => [
        { id: 'a', percent: 50, reason: 'ok' },
        { id: 'does-not-exist', percent: 99, reason: 'model tự bịa' },
      ],
    }),
    options,
  );

  assert.deepEqual(output.matches.map((m) => m.id), ['a']);
});

test('type trong output luôn lấy từ candidate thật của VNAIP, không phải từ model', async () => {
  const output = await checkDuplicates(
    validInput,
        deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async () => [{ id: 'a', percent: 50, reason: 'ok' }],
    }),
    options,
  );

  assert.equal(output.matches[0].type, 'solutions');
});

test('percent ngoài thang [0,100] bị loại', async () => {
  const output = await checkDuplicates(
    validInput,
        deps({
      findCandidates: async () => [candidate('a'), candidate('b')],
      scoreCandidates: async () => [
        { id: 'a', percent: 150, reason: 'quá cao' },
        { id: 'b', percent: -10, reason: 'âm' },
      ],
    }),
    options,
  );

  assert.deepEqual(output.matches, []);
});

test('percent không phải integer (thập phân) bị loại', async () => {
  const output = await checkDuplicates(
    validInput,
        deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async () => [
        { id: 'a', percent: 79.5, reason: 'thập phân' },
      ],
    }),
    options,
  );

  assert.deepEqual(output.matches, []);
});

test('ID trùng trong output model: chỉ giữ lần xuất hiện đầu tiên', async () => {
  const output = await checkDuplicates(
    validInput,
        deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async () => [
        { id: 'a', percent: 30, reason: 'lần 1' },
        { id: 'a', percent: 90, reason: 'lần 2 (trùng)' },
      ],
    }),
    options,
  );

  assert.equal(output.matches.length, 1);
  assert.equal(output.matches[0].reason, 'lần 1');
});

test('output thiếu reason (rỗng sau trim) bị loại', async () => {
  const output = await checkDuplicates(
    validInput,
        deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async () => [{ id: 'a', percent: 50, reason: '   ' }],
    }),
    options,
  );

  assert.deepEqual(output.matches, []);
});

test('output bị cắt tối đa 30 kết quả theo percent cao nhất', async () => {
  const candidates = Array.from({ length: 40 }, (_, i) => candidate(`c${i}`));
  const matches: RawModelMatch[] = candidates.map((c, i) => ({
    id: c.id,
    percent: i,
    reason: `percent ${i}`,
  }));

  const output = await checkDuplicates(
    validInput,
        deps({
      findCandidates: async () => candidates,
      scoreCandidates: async () => matches,
    }),
    { topK: 100, deadlineMs: 5000 },
  );

  assert.equal(output.matches.length, 30);
  assert.equal(output.matches[0].id, 'c39');
});

test('excludeIds loại ứng viên khỏi kết quả và không gửi chúng cho model', async () => {
  let scored: string[] = [];
  const output = await checkDuplicates(
    { ...validInput, excludeIds: ['a', 'khong-ton-tai'] },
    deps({
      findCandidates: async () => [candidate('a'), candidate('b')],
      scoreCandidates: async (_input, candidates) => {
        scored = candidates.map((c) => c.id);
        return candidates.map((c) => ({ id: c.id, percent: 70, reason: 'giống' }));
      },
    }),
    options,
  );

  assert.deepEqual(scored, ['b']);
  assert.deepEqual(output.matches.map((m) => m.id), ['b']);
});

test('model vẫn trả id nằm trong excludeIds thì id đó bị loại', async () => {
  const output = await checkDuplicates(
    { ...validInput, excludeIds: ['a'] },
    deps({
      findCandidates: async () => [candidate('a'), candidate('b')],
      scoreCandidates: async () => [
        { id: 'a', percent: 99, reason: 'model vẫn trả id đã bị loại' },
        { id: 'b', percent: 10, reason: 'ok' },
      ],
    }),
    options,
  );

  assert.deepEqual(output.matches.map((m) => m.id), ['b']);
});

test('loại excludeIds xong là hết ứng viên thì trả matches rỗng và không gọi model', async () => {
  const output = await checkDuplicates(
    { ...validInput, excludeIds: ['a'] },
    deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async () => {
        throw new Error('không nên được gọi khi không còn ứng viên');
      },
    }),
    options,
  );

  assert.deepEqual(output.matches, []);
});

test('top-k: nguồn ứng viên trả nhiều hơn k thì chỉ k sáng kiến GẦN NHẤT (đầu danh sách) được gửi cho model, không báo lỗi', async () => {
  let scored: string[] = [];
  const output = await checkDuplicates(
    validInput,
    deps({
      findCandidates: async () => Array.from({ length: 5 }, (_, i) => candidate(`c${i}`)),
      scoreCandidates: async (_input, candidates) => {
        scored = candidates.map((c) => c.id);
        return candidates.map((c) => ({ id: c.id, percent: 50, reason: 'ok' }));
      },
    }),
    { topK: 3, deadlineMs: 5000 },
  );

  assert.deepEqual(scored, ['c0', 'c1', 'c2'], 'giữ thứ hạng của nguồn: cắt đuôi là cắt các ứng viên xa nhất');
  assert.equal(output.matches.length, 3);
});

test('top-k tính SAU khi loại excludeIds: id bị loại không chiếm chỗ của k', async () => {
  let scored: string[] = [];
  await checkDuplicates(
    { ...validInput, excludeIds: ['c0'] },
    deps({
      // Nguồn không biết excludeIds (adapter lỏng): dedup vẫn phải loại rồi mới cắt k.
      findCandidates: async () => Array.from({ length: 4 }, (_, i) => candidate(`c${i}`)),
      scoreCandidates: async (_input, candidates) => {
        scored = candidates.map((c) => c.id);
        return [];
      },
    }),
    { topK: 3, deadlineMs: 5000 },
  );

  assert.deepEqual(scored, ['c1', 'c2', 'c3']);
});

test('bước embed chạy TRƯỚC khi tìm ứng viên; findCandidates nhận đúng input, vector và k', async () => {
  const order: string[] = [];
  const vectors = [[1, 0], [0, 1]];
  let received: { input?: unknown; query?: unknown } = {};
  await checkDuplicates(
    { ...validInput, excludeIds: ['x'] },
    deps({
      embedInput: async (input) => {
        order.push('embed');
        assert.equal(input.title, validInput.title);
        return vectors;
      },
      findCandidates: async (input, query) => {
        order.push('find');
        received = { input, query };
        return [];
      },
      scoreCandidates: async () => {
        order.push('score');
        return [];
      },
    }),
    { topK: 7, deadlineMs: 5000 },
  );

  assert.deepEqual(order, ['embed', 'find']);
  assert.deepEqual(received.query, { vectors, limit: 7 });
  assert.deepEqual((received.input as { excludeIds?: string[] }).excludeIds, ['x'], 'nguồn phải thấy excludeIds để loại ngay trong truy vấn');
});

test('embedding lỗi: propagate EMBEDDING_UNAVAILABLE, không tìm ứng viên, không gọi model, không trả matches rỗng im lặng', async () => {
  let touched = 0;
  await assert.rejects(
    () =>
      checkDuplicates(
        validInput,
        deps({
          embedInput: async () => {
            throw new Error('gemini 429');
          },
          findCandidates: async () => {
            touched += 1;
            return [];
          },
          scoreCandidates: async () => {
            touched += 1;
            return [];
          },
        }),
        options,
      ),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, 'EMBEDDING_UNAVAILABLE');
      assert.match(String((error.cause as Error).message), /gemini 429/);
      return true;
    },
  );
  assert.equal(touched, 0);
});

test('embedding trả danh sách vector rỗng cũng là EMBEDDING_UNAVAILABLE (không tìm với truy vấn rỗng)', async () => {
  let found = 0;
  await assert.rejects(
    () =>
      checkDuplicates(
        validInput,
        deps({
          embedInput: async () => [],
          findCandidates: async () => {
            found += 1;
            return [];
          },
        }),
        options,
      ),
    (error: unknown) => error instanceof DedupError && error.code === 'EMBEDDING_UNAVAILABLE',
  );
  assert.equal(found, 0);
});

test('DedupError từ nguồn ứng viên (vượt giới hạn đọc) được giữ nguyên mã, không bị gói thành CANDIDATES_UNAVAILABLE', async () => {
  await assert.rejects(
    () =>
      checkDuplicates(
        validInput,
        deps({
          findCandidates: async () => {
            throw new DedupError('CANDIDATE_LIMIT_EXCEEDED', 'kho quá lớn');
          },
        }),
        options,
      ),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, 'CANDIDATE_LIMIT_EXCEEDED');
      return true;
    },
  );
});

test('scoreCandidates nhận deadlineAt tính từ deadlineMs của lời gọi', async () => {
  let received: number | undefined;
  const before = Date.now();
  await checkDuplicates(
    validInput,
    deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async (_input, _candidates, scoreOptions) => {
        received = scoreOptions.deadlineAt;
        return [];
      },
    }),
    { topK: 30, deadlineMs: 4000 },
  );
  const after = Date.now();

  assert.ok(received !== undefined);
  assert.ok(received >= before + 4000 && received <= after + 4000);
});
