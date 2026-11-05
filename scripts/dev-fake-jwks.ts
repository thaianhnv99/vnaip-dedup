/**
 * JWKS server giả cho dev/test tay cục bộ, port cố định để backend có thể
 * trỏ SOTA_CORE_ORIGIN vào trước khi start. KHÔNG dùng production.
 *
 * Cách dùng (3 terminal):
 *   1. tsx scripts/dev-fake-jwks.ts                       # terminal A, giữ chạy
 *   2. SOTA_CORE_ORIGIN=http://127.0.0.1:4455 npm run dev  # terminal B
 *   3. tsx scripts/dev-call-check-duplicates.ts            # terminal C
 *
 * Mỗi lần restart script này sẽ sinh key mới — phải restart cả backend
 * (terminal B) cùng lúc nếu muốn JWKS khớp.
 *
 * Tool check-duplicates từ chối (403) người gọi không nằm trong allow-list, nên
 * backend phải có trong .env một dòng khớp token giả bên dưới, ví dụ:
 *   CHECK_DUPLICATES_ALLOWED_OIDS=org-dev-test
 * Cùng với QDRANT_* + GEMINI_API_KEY + LLM_SCORER_MODEL (hoặc QDRANT_MOCK_MODE=true
 * và LLM_MOCK_MODE=true: kho rỗng nên kết quả luôn rỗng; nạp dữ liệu mẫu bằng
 * scripts/seed-ideas.ts với Qdrant thật).
 */
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

const PORT = Number(process.env.FAKE_JWKS_PORT ?? 4455);
const APP_ID = process.env.FAKE_JWKS_APP_ID ?? 'vnaip-dedup';
const KID = 'dev-key-1';

async function main() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = 'EdDSA';
  jwk.use = 'sig';

  const server = createServer(async (request, response) => {
    if (request.url === '/.well-known/jwks.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }

    if (request.url?.startsWith('/mint-token')) {
      const url = new URL(request.url, 'http://localhost');
      const scope = url.searchParams.get('scope') ?? 'tool:check-duplicates';
      const token = await mintToken(privateKey, scope);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ token }));
      return;
    }

    response.statusCode = 404;
    response.end('Not found. Dùng /.well-known/jwks.json hoặc /mint-token?scope=...');
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Fake JWKS + token minter đang chạy tại http://127.0.0.1:${PORT}`);
    console.log(`Start backend với: SOTA_CORE_ORIGIN=http://127.0.0.1:${PORT} npm run dev`);
    console.log(`Lấy token test:    curl "http://127.0.0.1:${PORT}/mint-token?scope=tool:check-duplicates"`);
  });

  async function mintToken(key: CryptoKey, scope: string): Promise<string> {
    const claims: JWTPayload = {
      oid: 'org-dev-test',
      wid: 'ws-dev-test',
      iid: 'install-dev-test',
      sub: 'user-dev-test',
      scp: [scope],
    };
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: KID, typ: 'sota-invocation+jwt' })
      .setIssuer('sota/invocation-token')
      .setAudience(APP_ID)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key);
  }
}

main().catch((error) => {
  console.error('Không khởi động được fake JWKS server:', error);
  process.exitCode = 1;
});
