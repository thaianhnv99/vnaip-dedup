import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDuplicates,
  DedupError,
  type Candidate,
  type DedupDependencies,
  type RawModelMatch,
} from '../dedup.js';

const options = { topK: 30, deadlineMs: 5000, minScore: 0 };

const validInput = {
  type: 'solutions' as const,
  title: 'Giải pháp quản lý hồ sơ',
  content: 'Nội dung mô tả giải pháp quản lý hồ sơ số hóa.',
};

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return { id, type: 'solutions', title: `Candidate ${id}`, content: `Nội dung của ${id}`, ...overrides };
}

/** Mục chấm điểm thô của model: relation/evidence mặc định không liên quan tới phép thử. */
function raw(
  id: string,
  percent: number,
  reason: string,
  extra: Partial<RawModelMatch> = {},
): RawModelMatch {
  return {
    id,
    percent,
    reason,
    relation: 'same_problem',
    evidence: { newQuote: '', candidateQuote: '' },
    ...extra,
  };
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
    raw('a', 40, 'thấp'),
    raw('b', 90, 'cao'),
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
        scoreCandidates: async () => [raw('a', 70, 'giống')],
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
            return [raw('b', 99, 'khác type')];
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
        raw('a', 50, 'ok'),
        raw('does-not-exist', 99, 'model tự bịa'),
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
      scoreCandidates: async () => [raw('a', 50, 'ok')],
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
        raw('a', 150, 'quá cao'),
        raw('b', -10, 'âm'),
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
        raw('a', 79.5, 'thập phân'),
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
        raw('a', 30, 'lần 1'),
        raw('a', 90, 'lần 2 (trùng)'),
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
      scoreCandidates: async () => [raw('a', 50, '   ')],
    }),
    options,
  );

  assert.deepEqual(output.matches, []);
});

test('output bị cắt tối đa 30 kết quả theo percent cao nhất', async () => {
  const candidates = Array.from({ length: 40 }, (_, i) => candidate(`c${i}`));
  const matches: RawModelMatch[] = candidates.map((c, i) => raw(c.id, i, `percent ${i}`));

  const output = await checkDuplicates(
    validInput,
        deps({
      findCandidates: async () => candidates,
      scoreCandidates: async () => matches,
    }),
    { topK: 100, deadlineMs: 5000, minScore: 0 },
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
        return candidates.map((c) => (raw(c.id, 70, 'giống')));
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
        raw('a', 99, 'model vẫn trả id đã bị loại'),
        raw('b', 10, 'ok'),
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
        return candidates.map((c) => (raw(c.id, 50, 'ok')));
      },
    }),
    { topK: 3, deadlineMs: 5000, minScore: 0 },
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
    { topK: 3, deadlineMs: 5000, minScore: 0 },
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
    { topK: 7, deadlineMs: 5000, minScore: 0 },
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
    { topK: 30, deadlineMs: 4000, minScore: 0 },
  );
  const after = Date.now();

  assert.ok(received !== undefined);
  assert.ok(received >= before + 4000 && received <= after + 4000);
});

// --- Ngưỡng điểm, parentSolutionId, bằng chứng, titleSimilarity ---

test('minScore: chỉ ứng viên có percent >= ngưỡng vào kết quả, và ngưỡng được đưa cho scorer', async () => {
  let receivedMinScore: number | undefined;
  const output = await checkDuplicates(
    validInput,
    deps({
      findCandidates: async () => [candidate('a'), candidate('b'), candidate('c')],
      scoreCandidates: async (_input, _candidates, scoreOptions) => {
        receivedMinScore = scoreOptions.minScore;
        return [raw('a', 39, 'sát ngưỡng'), raw('b', 40, 'đúng ngưỡng'), raw('c', 95, 'cao')];
      },
    }),
    { ...options, minScore: 40 },
  );

  assert.equal(receivedMinScore, 40);
  assert.deepEqual(output.matches.map((m) => [m.id, m.percent]), [['c', 95], ['b', 40]]);
});

test('minScore không hợp lệ là lỗi cấu hình (RangeError), không phải INVALID_INPUT', async () => {
  for (const minScore of [-1, 101, 40.5, Number.NaN]) {
    await assert.rejects(
      () => checkDuplicates(validInput, deps({}), { ...options, minScore }),
      (error: unknown) => error instanceof RangeError,
      String(minScore),
    );
  }
});

test('parentSolutionId: ứng viên là sáng kiến cha bị ép relation=extension và percent <= 30, dù model chấm cao', async () => {
  const output = await checkDuplicates(
    { ...validInput, parentSolutionId: 'cha' },
    deps({
      findCandidates: async () => [candidate('cha'), candidate('khac')],
      scoreCandidates: async () => [
        raw('cha', 95, 'giống hệt', { relation: 'copy' }),
        raw('khac', 60, 'cùng vấn đề'),
      ],
    }),
    options,
  );

  assert.deepEqual(
    output.matches.map((m) => [m.id, m.percent, m.score, m.relation]),
    [
      ['khac', 60, 0.6, 'same_problem'],
      ['cha', 30, 0.3, 'extension'],
    ],
  );
});

test('parentSolutionId: điểm đã dưới 30 thì giữ nguyên; với ngưỡng 40 sáng kiến cha không xuất hiện trong kết quả', async () => {
  const input = { ...validInput, parentSolutionId: 'cha' };
  const scorer = async () => [raw('cha', 95, 'giống hệt', { relation: 'copy' }), raw('khac', 55, 'x')];
  const base = deps({ findCandidates: async () => [candidate('cha'), candidate('khac')], scoreCandidates: scorer });

  const low = await checkDuplicates(
    input,
    deps({ ...base, scoreCandidates: async () => [raw('cha', 12, 'khác nhiều', { relation: 'unrelated' })] }),
    options,
  );
  assert.deepEqual(low.matches.map((m) => [m.percent, m.relation]), [[12, 'extension']]);

  const filtered = await checkDuplicates(input, base, { ...options, minScore: 40 });
  assert.deepEqual(filtered.matches.map((m) => m.id), ['khac']);
});

test('relation ngoài danh sách bị loại như percent không hợp lệ', async () => {
  const output = await checkDuplicates(
    validInput,
    deps({
      findCandidates: async () => [candidate('a'), candidate('b')],
      scoreCandidates: async () => [
        raw('a', 70, 'ok', { relation: 'gan_giong' as never }),
        raw('b', 70, 'ok', { relation: 'paraphrase' }),
      ],
    }),
    options,
  );

  assert.deepEqual(output.matches.map((m) => [m.id, m.relation]), [['b', 'paraphrase']]);
});

test('bằng chứng: đoạn trích có thật (sau khi gộp khoảng trắng) được giữ, đoạn bịa hoặc bị sửa chữ thành chuỗi rỗng', async () => {
  const input = {
    ...validInput,
    title: 'Báo cáo sự cố',
    content: 'Nhân viên báo cáo sự cố\nqua ứng dụng di động.',
    fileExcerpts: ['Phụ lục: dùng chữ ký số để xác nhận.'],
  };
  const cases: Array<{ name: string; evidence: { newQuote: string; candidateQuote: string }; expected: { newQuote: string; candidateQuote: string } }> = [
    {
      name: 'cả hai đoạn có thật (một đoạn xuống dòng trong nguồn, một đoạn từ file đính kèm)',
      evidence: { newQuote: 'báo cáo sự cố qua ứng dụng', candidateQuote: 'Ứng dụng báo cáo sự cố' },
      expected: { newQuote: 'báo cáo sự cố qua ứng dụng', candidateQuote: 'Ứng dụng báo cáo sự cố' },
    },
    {
      name: 'đoạn từ fileExcerpts của input',
      evidence: { newQuote: 'dùng chữ ký số', candidateQuote: 'điện thoại' },
      expected: { newQuote: 'dùng chữ ký số', candidateQuote: 'điện thoại' },
    },
    {
      name: 'đoạn bịa hoặc sai chữ (đổi hoa/thường) bị bỏ',
      evidence: { newQuote: 'nhân viên báo cáo sự cố', candidateQuote: 'câu này không có trong sáng kiến' },
      expected: { newQuote: '', candidateQuote: '' },
    },
    {
      name: 'đoạn có thật nhưng ở sai phía bị bỏ',
      evidence: { newQuote: 'điện thoại', candidateQuote: 'ứng dụng di động' },
      expected: { newQuote: '', candidateQuote: '' },
    },
    {
      name: 'chuỗi rỗng giữ rỗng',
      evidence: { newQuote: '', candidateQuote: '   ' },
      expected: { newQuote: '', candidateQuote: '' },
    },
  ];

  for (const { name, evidence, expected } of cases) {
    const output = await checkDuplicates(
      input,
      deps({
        findCandidates: async () => [
          candidate('a', { title: 'Ứng dụng báo cáo sự cố', content: 'Báo cáo sự cố mặt đất qua điện thoại.' }),
        ],
        scoreCandidates: async () => [raw('a', 80, 'giống', { evidence })],
      }),
      options,
    );
    assert.deepEqual(output.matches[0]!.evidence, expected, name);
  }
});

test('bằng chứng: đoạn có thật dài hơn 200 ký tự bị cắt còn 200, và đoạn chỉ có trong matchedChunks vẫn được chấp nhận', async () => {
  const long = 'x'.repeat(500);
  const output = await checkDuplicates(
    { ...validInput, content: `Mở đầu. ${long}` },
    deps({
      findCandidates: async () => [
        candidate('a', { content: 'Nội dung ngắn', matchedChunks: ['Đoạn khớp ở phần cuối của sáng kiến'] }),
      ],
      scoreCandidates: async () => [
        raw('a', 80, 'giống', { evidence: { newQuote: long, candidateQuote: 'Đoạn khớp ở phần cuối' } }),
      ],
    }),
    options,
  );

  assert.equal(output.matches[0]!.evidence.newQuote, 'x'.repeat(200));
  assert.equal(output.matches[0]!.evidence.candidateQuote, 'Đoạn khớp ở phần cuối');
});

test('titleSimilarities: gắn titleSimilarity (làm tròn, kẹp 0..1) cho từng ứng viên trước khi chấm', async () => {
  let sent: Candidate[] = [];
  await checkDuplicates(
    validInput,
    deps({
      findCandidates: async () => [candidate('a'), candidate('b'), candidate('c')],
      titleSimilarities: async () => [0.123456, -0.2, 1.4],
      scoreCandidates: async (_input, candidates) => {
        sent = candidates;
        return [];
      },
    }),
    options,
  );

  assert.deepEqual(sent.map((c) => c.titleSimilarity), [0.1235, 0, 1]);
});

test('titleSimilarities lỗi, chậm quá ngân sách hoặc sai độ dài thì bị bỏ qua: vẫn chấm, ứng viên không có titleSimilarity', async () => {
  const hanging = () => new Promise<number[]>(() => undefined);
  const variants: Array<[string, NonNullable<DedupDependencies['titleSimilarities']>]> = [
    ['ném lỗi', async () => { throw new Error('embedding hết quota'); }],
    ['sai độ dài', async () => [0.5]],
    ['không bao giờ trả lời', hanging],
  ];

  for (const [name, titleSimilarities] of variants) {
    let sent: Candidate[] = [];
    const startedAt = Date.now();
    const output = await checkDuplicates(
      validInput,
      deps({
        findCandidates: async () => [candidate('a'), candidate('b')],
        titleSimilarities,
        scoreCandidates: async (_input, candidates) => {
          sent = candidates;
          return [raw('a', 60, 'ok')];
        },
      }),
      options,
    );

    assert.deepEqual(output.matches.map((m) => m.id), ['a'], name);
    assert.deepEqual(sent.map((c) => c.titleSimilarity), [undefined, undefined], name);
    assert.ok(Date.now() - startedAt < 5000, `${name}: không được chờ vô hạn`);
  }
});

test('titleSimilarities không được gọi khi không còn ứng viên nào', async () => {
  let called = false;
  const output = await checkDuplicates(
    validInput,
    deps({
      findCandidates: async () => [],
      titleSimilarities: async () => {
        called = true;
        return [];
      },
    }),
    options,
  );

  assert.deepEqual(output.matches, []);
  assert.equal(called, false);
});
