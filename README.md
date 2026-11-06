# vnaip-dedup

SotaAgent app generated with composable `sota init` recipes.

## Local development

Run the app watcher and Sota session in two terminals:

```bash
npm run dev       # app watchers (frontend and/or backend)
npm run dev:sota  # in another terminal: attach to your workspace
```

Add another capability at any time with `sota add`.

Editable source lives in `src/`. Generated frontend and backend output lives in `dist/`.

## Tool: `check-duplicates`

Kiểm tra mức độ tương đồng giữa một hồ sơ đầu vào và các sáng kiến cùng loại đã được duyệt
và index trong Qdrant, theo ba bước (hướng B: lọc top-k bằng vector rồi để model chấm):

1. **Embed input.** Nội dung hồ sơ được chia đoạn đúng như lúc index rồi embed trong một
   request (mỗi đoạn kèm tiêu đề).
2. **Lọc bằng vector.** Qdrant tìm `k` sáng kiến cùng loại gần nhất (mặc định 20,
   `CHECK_DUPLICATES_TOP_K`). Điểm của một sáng kiến là điểm cao nhất giữa các đoạn của input
   và các chunk của nó, nên hồ sơ dài không bị pha loãng. `excludeIds` được loại ngay trong
   truy vấn nên không chiếm chỗ của `k`.
3. **Chấm điểm.** Model Gemini đọc nội dung đầy đủ của `k` sáng kiến đó và chấm điểm.

Dữ liệu trong Qdrant do luồng index
(webhook → BullMQ → worker) nạp. `type` là `ideas`, `solutions` hoặc `initiatives`, mỗi
loại nằm ở một collection riêng (xem [Mô hình dữ liệu](#mô-hình-dữ-liệu-3-collection-theo-type)).
Xem contract đầy đủ trong:

- `src/schemas/dedup-input.schema.json`
- `src/schemas/dedup-output.schema.json`
- `src/backend/dedup.ts` (logic nghiệp vụ, framework-neutral, test được độc lập)
- `src/backend/input-embedder.ts` (bước 1: embed input)
- `src/backend/candidate-source.ts` (bước 2: tìm top-k ở Qdrant, gom chunk theo sáng kiến)
- `src/backend/llm-scorer.ts` (chấm điểm theo batch song song, có deadline)
- `src/backend/caller-policy.ts` (giới hạn ai được gọi tool)

### Mô hình dữ liệu: 3 collection theo type

Một server Qdrant, **ba collection riêng**, tên `<QDRANT_COLLECTION_PREFIX>_<type>`. Ví dụ
với `QDRANT_COLLECTION_PREFIX=vnaip_dedup_dev`:

| `type` | Collection |
| --- | --- |
| `ideas` | `vnaip_dedup_dev_ideas` |
| `solutions` | `vnaip_dedup_dev_solutions` |
| `initiatives` | `vnaip_dedup_dev_initiatives` |

Type được tách ở tầng lưu trữ, không phải đọc hết rồi lọc:

- **Ghi** (`POST /webhooks/idea-approved`): `type` bắt buộc và khớp chính xác một trong ba
  giá trị (phân biệt hoa/thường, số nhiều). Sai thì trả `400 INVALID_EVENT` **trước khi** có
  job nào vào hàng đợi; body dạng mảng thì một phần tử sai làm cả mảng bị từ chối. Worker ghi
  sáng kiến vào collection của `job.type`, và mỗi store từ chối ghi point mang type khác.
- **Kiểm tra trùng**: chỉ tìm và đọc collection của `type` được hỏi; hai collection còn lại
  không được mở ra, nên không thể so khớp chéo type. `type` ngoài ba giá trị bị `400 INVALID_INPUT`.
- **Reindex và xoá** chỉ tác động collection của type: dọn chunk thừa sau khi reindex và xoá
  một sáng kiến đều đi qua store của đúng type.
- **Cùng `id`, khác `type`** là hai sáng kiến độc lập ở hai collection. Gửi lại một `id` với
  type khác **không** xoá bản ở collection của type cũ; VNAIP BE cần giữ type của một sáng
  kiến cố định.
- **Từ mô hình một-collection chung**: `QDRANT_COLLECTION` không còn được đọc (thay bằng
  `QDRANT_COLLECTION_PREFIX`), collection cũ không được đọc hay tự chuyển đổi nên BE cần gửi
  lại event để index vào ba collection mới. Job `type: "solution"` còn trong Redis từ trước
  khi tách vào hàng chờ lỗi (`non_retryable:INVALID_TYPE`), không retry.

### Qdrant local bằng Docker

Qdrant chạy ngay trên máy, không cần tài khoản Cloud và **không cần API key**:

```bash
docker run -d --name vnaip-qdrant \
  -p 6333:6333 \
  -v vnaip_qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

- **Cổng 6333** là REST, cổng duy nhất app dùng (`QDRANT_URL=http://localhost:6333`). Qdrant
  còn tự mở cổng **6334** (gRPC) trong container; code này không dùng nên lệnh trên không
  publish nó.
- Volume `vnaip_qdrant_storage` giữ dữ liệu qua các lần dừng/xoá container. Bỏ dòng `-v` nếu
  muốn dữ liệu mất cùng container.
- Kiểm tra: `curl http://localhost:6333/collections` trả `"status":"ok"`; dashboard ở
  <http://localhost:6333/dashboard>. Dừng/chạy lại bằng `docker stop vnaip-qdrant` /
  `docker start vnaip-qdrant`.
- Tìm theo vector dùng Query API `points/query/groups`, nên cần Qdrant **>= 1.11** (đã thử trên 1.20).
- `http` chỉ được chấp nhận với `localhost`, `127.0.0.1` hoặc `[::1]`. App chạy trong một
  container khác và gọi `http://qdrant:6333` sẽ bị từ chối cấu hình; Qdrant ở host khác phải
  dùng `https` kèm `QDRANT_API_KEY`.

Cấu hình `.env` để dùng Qdrant này (collection được tạo ở lần ghi/đọc đầu của từng type):

```dotenv
QDRANT_MOCK_MODE=false
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION_PREFIX=vnaip_dedup_dev
```

### Ai được gọi tool

Không còn tách dữ liệu theo workspace, nên ai gọi được tool là so sánh được với mọi sáng
kiến cùng type.
Tool vì vậy **từ chối (403) mọi lời gọi** cho tới khi đặt ít nhất một danh sách trong
`CHECK_DUPLICATES_ALLOWED_SUBS` / `_OIDS` / `_WIDS`, và chỉ so khớp với claims đã xác
thực của Core (không bao giờ với body hay header). Đặt nhiều danh sách thì phải khớp tất cả.

### Hành vi cần biết

- **Chỉ `k` sáng kiến gần nhất được chấm, nên có thể bỏ sót.** Vector chỉ dùng để rút gọn tập
  ứng viên (mặc định `k = 20`, `CHECK_DUPLICATES_TOP_K`, tối đa 100). Sáng kiến trùng ý nhưng diễn
  đạt rất khác input có thể nằm ngoài top-k và model không bao giờ thấy nó, nên kết quả rỗng chỉ
  có nghĩa là không sáng kiến nào trong nhóm gần nhất bị chấm trùng. `k` nhỏ giảm chi phí và độ
  trễ (20 sáng kiến là 4 request chấm với batch 5) nhưng tăng nguy cơ này; phân tích rủi ro trong
  `docs/ke-hoach-phat-trien.md` (mục 10) khuyến nghị `k` rộng hơn (100–200) nếu ưu tiên không bỏ
  sót. Log `candidates_loaded` có `topScore` và `lastScore` (cosine của sáng kiến gần nhất và xa
  nhất trong top-k): `lastScore` còn cao nghĩa là top-k đang cắt giữa vùng còn rất giống, nên cân
  nhắc tăng `k`.
- **Vector phải cùng model với lúc index.** Web embed input rồi so với vector worker đã lưu, nên
  web và worker phải dùng cùng `EMBEDDING_MODEL` và `EMBEDDING_DIMENSIONS`. Nếu sáng kiến tìm được
  do model khác index (vector giả của `scripts/seed-ideas.ts`, hoặc vector cũ trước khi đổi model)
  thì tool trả `502 CANDIDATES_UNAVAILABLE` thay vì xếp hạng sai, và log `candidates_embedding_model_mismatch`
  nêu model mong đợi và model đã index. Cách sửa: index lại bằng model hiện hành. Khi
  `EMBEDDING_MOCK_MODE=true` thì bỏ qua kiểm này.
- **`503 CANDIDATE_LIMIT_EXCEEDED` chỉ còn khi nội dung của `k` sáng kiến vượt giới hạn đọc**
  (10000 chunk), gần như không xảy ra. Số sáng kiến trong kho không còn gây lỗi này.
- **Lỗi một phần là lỗi.** Một batch chấm điểm lỗi hoặc hết giờ thì cả lời gọi trả `502
  SCORING_UNAVAILABLE`; không trả điểm của một phần ứng viên.
- **Body lỗi có mã truy vết và lý do gốc của lỗi chấm điểm.** Mọi lỗi của tool kèm
  `requestId` (cùng giá trị header `x-request-id` và field `requestId` trong log
  `check_duplicates_failed`). Riêng `502 SCORING_UNAVAILABLE` do scorer gây ra còn có `cause`
  (`BAD_OUTPUT`, `TIMEOUT`, `RATE_LIMITED`, `AUTH_ERROR`, `NETWORK_ERROR`) và `detail` (chỉ các field trong
  allow-list: `reason`, `finishReason`, `jsonType`, `contentLength`, `topLevelKeyCount`,
  `expectedCount`, `scoredCount`, và với `reason: "incomplete_scores"` là các số đếm nguyên nhân
  `entryCount`, `malformedCount`, `unknownIdCount`, `duplicateCount`, `percentNotIntegerCount`,
  `percentOutOfRangeCount`, `reasonBlankCount`). Lỗi tạo embedding cho input (`502
  EMBEDDING_UNAVAILABLE`) có `cause` (`RATE_LIMITED`, `AUTH_ERROR`, `TIMEOUT`, `NETWORK_ERROR`,
  `UPSTREAM_ERROR`, `BAD_REQUEST`, `BAD_RESPONSE`, `INVALID_INPUT`) nhưng không có `detail`. Ví dụ output bị cắt:
  `{"code":"SCORING_UNAVAILABLE","message":"…","requestId":"…","cause":"BAD_OUTPUT","detail":{"reason":"truncated","finishReason":"length","contentLength":371}}`.
  Không bao giờ có nội dung model sinh, nội dung hồ sơ hay message gốc của provider; những thứ
  đó không ra khỏi app. Lỗi lấy ứng viên (`CANDIDATES_UNAVAILABLE`) chỉ có `requestId`.
- **Chỉ so sánh sáng kiến cùng `type`** với input (`ideas`, `solutions` hoặc `initiatives`),
  tìm trong collection riêng của type đó. `k` và giới hạn đọc tính theo từng type, không cộng
  dồn các type.
- Nội dung mỗi ứng viên đưa vào prompt bị cắt ở `LLM_SCORER_MAX_CANDIDATE_CHARS` (4000 ký tự).
- `parentSolutionId` được chấp nhận nhưng chưa dùng để lọc (vai trò chưa được nghiệp vụ xác nhận).
- Input dùng `excludeIds` (mảng); `excludeId` và `datasetKey` bị từ chối (400): BE phải đổi.

### Cấu hình

Copy `.env.example` thành `.env` và chỉnh các biến. Tiến trình **web** cần cấu hình Qdrant
(cùng Qdrant và cùng `QDRANT_COLLECTION_PREFIX` với worker), `GEMINI_API_KEY` (embed input và
chấm điểm), cùng `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` với worker, `LLM_SCORER_MODEL` và
danh sách người gọi. Biến chính của tool:

| Biến | Mô tả |
| --- | --- |
| `CHECK_DUPLICATES_ALLOWED_SUBS`, `_OIDS`, `_WIDS` | Danh sách claim được phép gọi tool (phân tách bằng dấu phẩy, AND giữa các danh sách). Không đặt danh sách nào thì 403 cho tất cả. |
| `CHECK_DUPLICATES_TOP_K` | `k` của top-k: số sáng kiến gần input nhất được gửi cho model chấm (mặc định 20, tối đa 100). Thay cho `CHECK_DUPLICATES_CANDIDATE_LIMIT`, biến cũ đó không còn được đọc. |
| `CHECK_DUPLICATES_DEADLINE_MS` | Tổng thời gian cho cả lời gọi: embed + tìm + chấm (mặc định 28000, nhỏ hơn `timeoutMs` 30000 của tool). |
| `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` | Model và số chiều embedding (mặc định `gemini-embedding-001`, 1536). **Phải trùng với worker**: web embed input rồi so với vector worker đã lưu. |
| `GEMINI_API_KEY` | Khoá Gemini API, dùng chung cho scorer và embedding. `OPENROUTER_*` và `GEMINI_BASE_URL` không còn được đọc. |
| `EMBEDDING_BASE_URL` | Tuỳ chọn: base URL của embedding (mặc định `https://generativelanguage.googleapis.com/v1beta`, API gốc của Gemini). Khác base URL của scorer. |
| `LLM_SCORER_BASE_URL`, `LLM_SCORER_API_KEY` | Tuỳ chọn: khoá/endpoint riêng cho scorer, không ảnh hưởng embedding. Hạn mức free tier tính theo project chứ không theo khoá, nên khoá của project khác có hạn mức riêng. Không đặt thì dùng `GEMINI_*`. Đã đặt `LLM_SCORER_BASE_URL` thì bắt buộc đặt `LLM_SCORER_API_KEY`: `GEMINI_API_KEY` không bao giờ được gửi sang host khác. |
| `LLM_SCORER_REASONING_EFFORT` | Tuỳ chọn: `none`, `minimal`, `low`, `medium` hoặc `high`, gửi làm `reasoning_effort`. Không đặt thì không gửi. Dùng khi model reasoning ăn hết `max_tokens` làm output bị cắt. Giá trị sai thì tool trả `503 TOOL_NOT_CONFIGURED`. |
| `LLM_SCORER_MODEL` | Model chấm điểm (tên Gemini, ví dụ `gemini-3.6-flash`; `gemini-2.5-flash` đã bị Google gỡ khỏi người dùng mới, gọi trả HTTP 404). **Không có mặc định.** Chưa đo thời gian với Gemini: chạy `npx tsx scripts/check-gemini.ts` (xem [Chuyển sang Gemini](#chuyển-sang-gemini-free-tier)). |
| `LLM_SCORER_BATCH_SIZE`, `LLM_SCORER_CONCURRENCY`, `LLM_SCORER_TIMEOUT_MS`, `LLM_SCORER_MAX_CANDIDATE_CHARS` | Số ứng viên mỗi lần gọi (5), số lần gọi song song (20), trần thời gian mỗi lần (25000ms), phần nội dung tối đa mỗi ứng viên (4000 ký tự). Mặc định đo với model khác; với free tier cần chỉnh theo hạn mức (xem bên dưới). |
| `QDRANT_URL` | URL REST của Qdrant, ví dụ `http://localhost:6333` (Docker local). |
| `QDRANT_COLLECTION_PREFIX` | Tiền tố của ba collection `<tiền tố>_ideas`, `_solutions`, `_initiatives`. Mỗi môi trường một tiền tố. Thay `QDRANT_COLLECTION`. |
| `QDRANT_API_KEY` | Không cần với Qdrant local. Chỉ bắt buộc khi `QDRANT_URL` không phải localhost (và phải `https`). |
| `LLM_MOCK_MODE`, `QDRANT_MOCK_MODE` | `true` dùng scorer mock / kho trong bộ nhớ (ba kho theo type, rỗng, không chia sẻ với worker). Không đặt nghĩa là dùng dịch vụ thật. |

Không commit giá trị thật của `GEMINI_API_KEY`, `LLM_SCORER_API_KEY`, `QDRANT_API_KEY` (nếu
có dùng), `WEBHOOK_HMAC_SECRETS`.

### Chuyển sang Gemini (free tier)

Scorer và embedding dùng chung `GEMINI_API_KEY` nhưng đi qua hai endpoint khác nhau: scorer gọi endpoint
tương thích OpenAI (`/v1beta/openai/chat/completions`), embedding gọi API gốc
(`/v1beta/models/{model}:batchEmbedContents`, khoá ở header `x-goog-api-key`).
Các điều cần biết khi dùng free tier và khi đổi từ OpenRouter:

1. **Kiểm thử bằng khoá thật trước khi deploy:** `npx tsx scripts/check-gemini.ts` (thêm
   `--burst=10` để thử hạn mức). Script gọi đúng code production và kiểm: khoá hợp lệ, model có
   trong danh sách, chat nhận `response_format`/`max_tokens`/`reasoning_effort`, API gốc nhận
   `outputDimensionality` ở cấp trên cùng của request (thử cả `embedContentConfig.outputDimensionality`,
   cách này bị API bỏ qua âm thầm và vẫn trả 3072 chiều). Nó chỉ in mã HTTP, tên model, số chiều và thời gian, không in khoá hay body.
2. **Hạn mức free tier thấp và tính theo project.** Mỗi lần check dùng
   `ceil(số ứng viên / LLM_SCORER_BATCH_SIZE)` request; mặc định batch 5 là 20 request cho 100
   ứng viên và dễ trả `429`. Khi đó response có `cause: "RATE_LIMITED"`. Tăng
   `LLM_SCORER_BATCH_SIZE` và giảm `LLM_SCORER_CONCURRENCY` cho khớp hạn mức trong AI Studio; batch
   lớn thì mỗi lần gọi chậm hơn nên phải đo lại với `CHECK_DUPLICATES_DEADLINE_MS`.
3. **Thinking bật mặc định** và token suy nghĩ có thể làm output bị cắt
   (`cause: "BAD_OUTPUT"`, `detail.reason: "truncated"`). Đặt `LLM_SCORER_REASONING_EFFORT=none`
   (2.5 Flash cho phép; 2.5 Pro và dòng 3 không tắt được).
4. **Embedding:** `gemini-embedding-001` mặc định 3072 chiều, app gửi `outputDimensionality: 1536` để
   khớp collection Qdrant hiện có (không phải tạo lại collection), và tự chuẩn hoá L2 vector vì
   Gemini không chuẩn hoá khi cắt khỏi 3072 chiều. App dùng `:batchEmbedContents` (một request cho
   cả batch chunk) thay vì `:embedContent` từng chunk để tiết kiệm hạn mức request. Vector đã index bằng
   `text-embedding-3-small` vẫn nằm trong collection nhưng **không so sánh được** với vector mới.
   Vì tool `check-duplicates` tìm theo vector (hướng B), vector cũ phải được index lại bằng model
   hiện hành (VNAIP BE gửi lại sự kiện, hoặc `scripts/seed-ideas.ts` với khoá Gemini thật); nếu không
   tool trả `502 CANDIDATES_UNAVAILABLE` thay vì xếp hạng sai (xem "Hành vi cần biết").
5. **Dữ liệu gửi cho Google:** nội dung sáng kiến được gửi tới Gemini API. Điều khoản của free tier
   khác bản trả phí về việc Google có dùng dữ liệu để cải thiện sản phẩm hay không; đọc điều khoản
   hiện hành trước khi dùng dữ liệu thật.
6. **Đổi env ở nơi deploy:** thay `OPENROUTER_API_KEY` bằng `GEMINI_API_KEY` (và đặt
   `LLM_SCORER_MODEL` kiểu Gemini) cho cả web lẫn worker. Thiếu thì tool trả
   `503 TOOL_NOT_CONFIGURED`, worker báo `NOT_CONFIGURED`.

### Chạy local

```bash
npm install
npm run dev        # app backend, terminal 1
npm run dev:sota    # Sota dev session + tunnel, terminal 2
```

Luồng index chạy ở hai tiến trình: web (`npm run dev`, hosted `npm start`) chỉ nhận
webhook rồi đẩy job vào Redis; worker (`npm run dev:worker`, hosted
`npm run start:worker`) xử lý job. Với `QUEUE_MOCK_MODE=true` (hàng đợi trong bộ nhớ,
chỉ cục bộ) web tự chạy worker nên không cần chạy thêm. Khi dùng BullMQ thật
(`REDIS_URL`), phải chạy worker riêng với cùng `REDIS_URL`, `QUEUE_PREFIX`, `QUEUE_NAME`.
Chi tiết: `docs/ke-hoach-phat-trien.md` (GĐ2).

Thử tool cục bộ không cần Core thật: chạy `scripts/dev-fake-jwks.ts` rồi
`scripts/dev-call-check-duplicates.ts` (xem đầu hai file). Token giả mang `oid=org-dev-test`,
nên đặt `CHECK_DUPLICATES_ALLOWED_OIDS=org-dev-test` trong `.env`.

### Dữ liệu mẫu

`scripts/seed-ideas.ts` nạp 11 sáng kiến mẫu (id `SEED-GP-xxxx`) vào Qdrant qua đúng đường
index của worker, để thử tool mà không cần VNAIP BE gửi webhook. Mỗi sáng kiến đi vào
collection của `type` ghi trong `scripts/seed-ideas.json`: 3 `ideas`, 4 `solutions`, 4
`initiatives`. Có hai cặp gần như trùng nhau (cùng type), một sáng kiến nhiều chunk, và một
cặp "sinh đôi khác type" (`SEED-GP-0011` ở `initiatives` gần như y hệt `SEED-GP-0001` ở
`ideas`): kiểm tra trùng cho `ideas` với nội dung của `0001` phải thấy `0002` mà không bao giờ
thấy `0011`, và ngược lại.

```bash
npx tsx scripts/seed-ideas.ts --collection-prefix vnaip_dedup_dev           # nạp
npx tsx scripts/seed-ideas.ts --collection-prefix vnaip_dedup_dev --clean   # xoá
```

Rào an toàn: `--collection-prefix` bắt buộc và phải trùng `QDRANT_COLLECTION_PREFIX`; script
từ chối tiền tố có chữ "prod" (nên cả ba collection dẫn xuất cũng không có) và
`QDRANT_MOCK_MODE=true`; mọi id mẫu phải bắt đầu bằng `SEED-`; `--clean` chỉ xoá đúng các id
trong file mẫu, mỗi id khỏi đúng collection của type của nó. Cờ `--collection` của bản
một-collection đã được thay bằng `--collection-prefix`. Có thể dùng `EMBEDDING_MOCK_MODE=true`
(luồng 1 không dùng vector khi truy vấn); khi đó dữ liệu mẫu mang nhãn model `mock-embedding`.

### Kiểm thử

```bash
npm run typecheck        # typecheck mã production (src/backend, không gồm __tests__)
npm run typecheck:tests   # typecheck toàn bộ gồm __tests__
npm run build             # build mã production sang dist/backend
npm test                  # chạy toàn bộ unit test (node:test qua tsx)
sota validate              # validate manifest.yaml
```

`npm test` yêu cầu Node ≥ 20.3 (WebCrypto global cần cho `jose`, `AbortSignal.any` cho scorer). Nếu máy bạn
dùng `nvm` và đang ở Node 18, chạy `nvm use 22` (hoặc mới hơn) trước. Một số test tích hợp
chỉ chạy khi đặt `REDIS_TEST_URL`.

Các test chính của luồng kiểm tra trùng (xem `src/backend/__tests__/`):

- `dedup.test.ts`: logic nghiệp vụ, lỗi nguồn ứng viên/model propagate đúng thay vì trả
  "không trùng" im lặng, `excludeIds`, vượt trần, deadline.
- `candidate-source.test.ts`: gom chunk, index lại giữa chừng, scroll bị cắt; **chỉ đọc
  collection của type được hỏi** (hai collection còn lại không bị scroll), ba type cùng `id` và
  cùng nội dung không lẫn nhau.
- `vector-store.test.ts`, `qdrant-store.test.ts`: store từ chối point sai type, `forType` từ
  chối type lạ, tên collection `<tiền tố>_<type>`, mỗi thao tác Qdrant chỉ gọi đúng collection
  của type (qua Qdrant giả), xoá/dọn chunk không động tới type khác.
- `index-job.test.ts`, `webhook-routes.test.ts`, `index-event.test.ts`: webhook từ chối type
  sai (cả theo mảng) trước khi enqueue, worker ghi/reindex/xoá đúng collection, job type cũ
  vào hàng chờ lỗi không retry.
- `llm-scorer.test.ts`: URL base giữ nguyên đường dẫn, batch song song, giới hạn đồng thời,
  deadline, một batch lỗi thì cả lời gọi lỗi, không lộ khoá API.
- `caller-policy.test.ts`, `check-duplicates-http.test.ts`: giới hạn người gọi, qua cả chuỗi
  Express thật + xác thực JWT thật (JWKS giả); claims không khớp bị 403, danh tính khai
  trong body/header không có tác dụng.
- `check-duplicates-pipeline.test.ts`: index → kiểm tra trùng trong cùng tiến trình (mốc MVP);
  ba type có nội dung y hệt nhau thì mỗi type chỉ thấy và chỉ gửi model sáng kiến của mình, kể
  cả khi model trả về `id` của type khác.
- `validate-input.test.ts`, `validate-output.test.ts`: validate tay theo đúng JSON Schema
  (SotaAgents không tự kiểm tra outputSchema tại runtime).
- `sota-auth.test.ts`: JWT hợp lệ, thiếu token, hết hạn, audience sai, thiếu scope.

### Việc còn lại trước khi tích hợp VNAIP và triển khai production

Xem `docs/ke-hoach-phat-trien.md` (GĐ0 còn hai mục, GĐ3, GĐ4, GĐ5). Tóm tắt các điểm chưa
được xác nhận:

1. Claim nhận diện service account của VNAIP BE (để đặt `CHECK_DUPLICATES_ALLOWED_*`):
   deploy Staging với `LOG_VERIFIED_CLAIMS=true`, cho BE gọi tool một lần, đọc log
   `invocation_accepted`. Cho tới khi đặt danh sách, tool trả 403.
2. Chọn model chấm điểm (`LLM_SCORER_MODEL`) và đo thời gian trả lời với dữ liệu thật.
3. Vai trò của `parentSolutionId`, ngưỡng hiển thị và số kết quả tối đa theo nghiệp vụ thật.
   (Danh sách `type` đã chốt là `ideas` / `solutions` / `initiatives`; VNAIP BE phải gửi đúng
   các giá trị này.)
4. `timeoutMs` tối đa khi build artifact (schema chỉ ràng buộc `minimum: 1`).
5. Giá trị `k` phù hợp (mặc định 20) và có cần ngưỡng similarity hay không: đo recall (tỉ lệ
   sáng kiến trùng thật nằm trong top-k) bằng dữ liệu và model thật.
