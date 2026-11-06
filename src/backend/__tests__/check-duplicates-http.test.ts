import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import { setupFakeCore, signToken } from './helpers/fake-core.js';
import { loadCallerPolicy } from '../caller-policy.js';

/**
 * Kiểm tra cả chuỗi middleware thật của /tools/check-duplicates qua HTTP:
 * parser JSON → xác thực JWT (JWKS giả) → giới hạn người gọi → handler. Đây là test
 * cho tiêu chí GĐ3 "claims không khớp bị từ chối".
 *
 * sota-auth.ts đọc SOTA_CORE_ORIGIN lúc import, nên env phải được đặt trước khi
 * import tool-routes (mỗi file test chạy trong tiến trình riêng nên không ảnh hưởng test khác).
 */

let core: Awaited<ReturnType<typeof setupFakeCore>>;
let registerToolRoutes: typeof import('../tool-routes.js').registerToolRoutes;
let installBodyParsers: typeof import('../webhook-routes.js').installBodyParsers;

before(async () => {
  core = await setupFakeCore();
  process.env.SOTA_CORE_ORIGIN = core.origin;
  // Đường dựng mặc định của handler dùng env này: kho trong bộ nhớ (rỗng), embedding và scorer mock.
  process.env.QDRANT_MOCK_MODE = 'true';
  process.env.EMBEDDING_MOCK_MODE = 'true';
  process.env.LLM_MOCK_MODE = 'true';
  ({ registerToolRoutes } = await import('../tool-routes.js'));
  ({ installBodyParsers } = await import('../webhook-routes.js'));
});

after(() => {
  core.server.close();
});

const validBody = {
  body: { input: { type: 'solutions', title: 'Ứng dụng báo cáo sự cố', content: 'Báo cáo sự cố mặt đất.' } },
};

async function withApp(
  env: Record<string, string>,
  run: (call: (token: string | undefined, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>, reached: () => number) => Promise<void>,
  spy = false,
) {
  const app = express();
  installBodyParsers(app, null);
  let reachedCount = 0;
  const spyHandler: RequestHandler = (_request, response) => {
    reachedCount += 1;
    response.json({ matches: [] });
  };
  registerToolRoutes(app, 'vnaip-dedup', {
    callerPolicy: loadCallerPolicy(env),
    ...(spy ? { checkDuplicates: spyHandler } : {}),
  });

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('không bind được app test');

  const call = async (token: string | undefined, body: unknown = validBody, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/tools/check-duplicates`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  try {
    await run(call, () => reachedCount);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const token = (overrides: Parameters<typeof signToken>[2] = {}) => signToken(core.privateKey, core.kid, overrides);

test('không có token trả 401 và không chạm handler', async () => {
  await withApp({ CHECK_DUPLICATES_ALLOWED_SUBS: 'svc-vnaip-be' }, async (call, reached) => {
    const result = await call(undefined);
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'AUTH_ERROR');
    assert.equal(reached(), 0);
  }, true);
});

test('sub nằm trong danh sách cho phép: 200 qua đường dựng mặc định (kho rỗng thì không có ứng viên)', async () => {
  await withApp({ CHECK_DUPLICATES_ALLOWED_SUBS: 'svc-vnaip-be' }, async (call) => {
    const result = await call(await token({ sub: 'svc-vnaip-be' }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { matches: [] });
  });
});

test('sub không nằm trong danh sách: 403 CALLER_NOT_ALLOWED và handler không bao giờ chạy', async () => {
  await withApp({ CHECK_DUPLICATES_ALLOWED_SUBS: 'svc-vnaip-be' }, async (call, reached) => {
    const result = await call(await token({ sub: 'user-khac' }));
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'CALLER_NOT_ALLOWED');
    assert.equal(reached(), 0);
  }, true);
});

test('chưa cấu hình danh sách nào: 403 cho mọi người gọi, kể cả token hợp lệ', async () => {
  await withApp({}, async (call, reached) => {
    const result = await call(await token({ sub: 'svc-vnaip-be' }));
    assert.equal(result.status, 403);
    assert.equal(reached(), 0);
  }, true);
});

test('allow-list theo oid: đúng tổ chức qua, tổ chức khác (cùng sub) bị 403', async () => {
  await withApp({ CHECK_DUPLICATES_ALLOWED_OIDS: 'org-vnaip' }, async (call, reached) => {
    assert.equal((await call(await token({ oid: 'org-vnaip', sub: 'bat-ky' }))).status, 200);
    assert.equal((await call(await token({ oid: 'org-khac', sub: 'bat-ky' }))).status, 403);
    assert.equal(reached(), 1);
  }, true);
});

test('allow-list theo wid: workspace khác của cùng tổ chức bị 403', async () => {
  await withApp({ CHECK_DUPLICATES_ALLOWED_WIDS: 'ws-vnaip' }, async (call) => {
    assert.equal((await call(await token({ wid: 'ws-vnaip' }))).status, 200);
    assert.equal((await call(await token({ wid: 'ws-khac' }))).status, 403);
  }, true);
});

test('danh tính khai trong body hoặc header không ký không giúp vượt qua: chỉ claims đã xác thực được tin', async () => {
  await withApp({ CHECK_DUPLICATES_ALLOWED_SUBS: 'svc-vnaip-be', CHECK_DUPLICATES_ALLOWED_OIDS: 'org-vnaip' }, async (call, reached) => {
    const result = await call(
      await token({ sub: 'user-khac', oid: 'org-khac' }),
      { ...validBody, sub: 'svc-vnaip-be', oid: 'org-vnaip', body: { ...validBody.body, sub: 'svc-vnaip-be' } },
      { 'x-sota-sub': 'svc-vnaip-be', 'x-sota-oid': 'org-vnaip', 'x-forwarded-user': 'svc-vnaip-be' },
    );
    assert.equal(result.status, 403);
    assert.equal(reached(), 0);
  }, true);
});

test('token đúng người nhưng thiếu scope tool:check-duplicates vẫn bị 401, allow-list không thay thế kiểm scope', async () => {
  await withApp({ CHECK_DUPLICATES_ALLOWED_SUBS: 'svc-vnaip-be' }, async (call, reached) => {
    const result = await call(await token({ sub: 'svc-vnaip-be', scp: ['tool:khac'] }));
    assert.equal(result.status, 401);
    assert.equal(reached(), 0);
  }, true);
});

test('người gọi được phép nhưng input chứa datasetKey/excludeId cũ: 400 INVALID_INPUT', async () => {
  await withApp({ CHECK_DUPLICATES_ALLOWED_SUBS: 'svc-vnaip-be' }, async (call) => {
    const valid = await token({ sub: 'svc-vnaip-be' });
    for (const extra of [{ datasetKey: 'ws-1' }, { excludeId: 'GP-1' }]) {
      const result = await call(valid, { body: { input: { ...validBody.body.input, ...extra } } });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'INVALID_INPUT');
    }
  });
});
