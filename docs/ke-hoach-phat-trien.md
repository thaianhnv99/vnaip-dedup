# Kế hoạch phát triển vnaip-dedup theo thiết kế mới

> Nguồn: `vnaip-dedup-design.md` (thiết kế tổng hợp từ phản hồi của anh Hưng).
> Phạm vi: chia công việc thành các giai đoạn phát triển, có phụ thuộc và tiêu chí xong.
> Ngày lập: 2026-11-03. Cập nhật 2026-11-04: GĐ0 và GĐ1 xong; GĐ2 xong phần lõi (webhook, BullMQ, worker tách tiến trình riêng), còn phần file/MinIO đang để `#TODO`; GĐ3 xong phần mã, test và đã chạy thử thật trên Qdrant Cloud + OpenRouter (Sonnet 5.5); còn thiếu claim thật của BE, số dư OpenRouter và phép đo 100 sáng kiến bằng Sonnet. Queue và luồng file được sửa theo diagram `Final1.png` (mục 3.3); cùng ngày bỏ `datasetKey`, chốt Redis tự host và tách worker (mục 3.2 dòng 9 đến 11).

## 1. Hiện trạng so với thiết kế mới

- Tool `check-duplicates` đã có: xác thực JWT/JWKS, validate input/output, LLM scorer. Candidate lấy từ VNAIP BE và cả hai phần (VNAIP client, LLM scorer) đang ở mock mode.
- Chưa có: embedding, Qdrant, webhook, queue, worker.
- Thiết kế mới bỏ VNAIP client và thay bằng Qdrant. Phần lớn `src/backend/dedup.ts` và `src/backend/llm-scorer.ts` dùng lại được.
- `src/backend/sota-auth.ts` đang có thay đổi chưa commit, chủ yếu là format lại. Có một thay đổi cần chú ý: Core origin mặc định đổi từ `https://api.v4.stg.sotaagents.ai` sang `https://api.v4.sotaagents.ai`. Manifest có môi trường `stg`, nên hosted phải đặt `SOTA_CORE_ORIGIN` tường minh.

## 2. Tổng quan các giai đoạn

| GĐ | Tên | Kết quả chính | Phụ thuộc |
|---|---|---|---|
| 0 | Chốt quyết định chặn | Các câu hỏi mục 11 của thiết kế được trả lời, dọn nợ nhỏ | — |
| 1 | Nền tảng: OpenRouter và Qdrant | Embedding client, Qdrant client, module tenant filter | GĐ0 |
| 2 | Luồng index | Webhook → queue → worker → Qdrant chạy được | GĐ1 |
| 3 | Luồng kiểm tra trùng mới | `check-duplicates` lấy ứng viên từ Qdrant | GĐ1 (song song GĐ2 được nhờ seed data) |
| 4 | Vòng đời dữ liệu | Backfill, cập nhật/xoá, callback trạng thái, cache | GĐ2 và GĐ3 |
| 5 | Hardening và release | Test bảo mật, observability, deploy stg → prod | GĐ4 |

Mốc MVP là hết GĐ3: một ý tưởng được duyệt → được index → kiểm tra trùng tìm thấy nó, chạy trên stg.

```
GĐ0 → GĐ1 ─┬→ GĐ2 ─┐
           └→ GĐ3 ─┴→ GĐ4 → GĐ5
```

## 3. GĐ0: Chốt quyết định chặn

Giai đoạn này không viết code. Chỉ các điểm sau thật sự chặn các giai đoạn sau.

- [x] **Auth webhook và tách dữ liệu theo workspace (mục 11 #2).** Auth đã chốt **HMAC-SHA256 kèm timestamp** (đổi từ API key tĩnh ngày 2026-11-04, xem quyết định #12 và `docs/webhook-vnaip-be.md`). Phần tách dữ liệu theo `datasetKey` (chốt 2026-11-03) đã **bị bỏ ngày 2026-11-04**: mọi sáng kiến nằm chung một tập dữ liệu, xem mục 3.2 dòng 9 và "Điểm mở còn lại".
- [x] **Hướng A hay B ở luồng 1 (#4).** Đã chọn hướng A (lấy tất cả ứng viên); **đổi sang hướng B (top-k theo vector) ngày 2026-11-06**, xem quyết định #17 ở mục 3.2.
- [x] **Payload Qdrant và chunk (#5, #7).** Đã chốt, xem mục 3.2.
- [x] **Embedding model và nơi gọi (#6).** Đã chốt `openai/text-embedding-3-small` qua OpenRouter.
- [x] **Giữ SotaAgents Core trong luồng 1 hay không (#1).** Đã chốt giữ qua Core.
- [x] **File đính kèm.** Ban đầu chốt theo khuyến nghị; sau đó đổi theo diagram `Final1.png`: BE gửi `fileRef` (tham chiếu file trong MinIO của VNAIP), xem mục 3.3. MinIO chưa có nên phần này là `#TODO`.
- [x] **Cách khai báo webhook trong manifest.** Đã khảo sát ngày 2026-11-03, xem mục 3.1: manifest không có chỗ khai báo webhook từ hệ thống ngoài.
- [ ] **Xác định claim nhận diện BE (cách A).** Deploy Staging với `LOG_VERIFIED_CLAIMS=true`, để BE gọi tool `check-duplicates` một lần, đọc log `invocation_accepted` để biết `sub` hoặc claim nào cố định cho service account của BE. Từ khi bỏ `datasetKey`, claim này dùng để **giới hạn ai được gọi tool** (không còn để tin `datasetKey`). Nếu không có claim nào dùng được thì giới hạn theo `oid`/`wid` của VNAIP.
- [ ] **Dọn nợ.** Commit `sota-auth.ts` (nay gồm cả log claims tạm), đặt `SOTA_CORE_ORIGIN` cho từng môi trường hosted.

### 3.1 Kết quả khảo sát GĐ0 (2026-11-03, sota CLI 1.16.1)

**Đã xác minh bằng CLI:**

- `sota validate` đạt (server-side preflight) với manifest hiện tại.
- Manifest v3 không có chỗ khai báo webhook gọi từ hệ thống ngoài. `events` / `events_consume` chỉ nhận Bus hoặc App Data CDC (topic dạng `appdata.<app>:<collection>@<n>.insert|update|replace|delete`) qua signed delivery từ Core (`sota manifest explain skills.event`). `lifecycle` (softDelete, archive, erase, export) cũng là Core gọi app.
- Hệ quả: webhook index là một route HTTP thường trên `service.baseUrl` công khai, không khai báo trong manifest, không đi qua Core nên không có JWT và không có claims `iid/oid/wid`. App phải tự xác thực, và tenant của dữ liệu index không thể lấy từ claims. Đây là lý do cần chốt tenant binding trước GĐ2.
- Manifest có khai báo `env` (tên biến, đánh dấu `required`/`secret`) và `sota env template` / `sota env check` dùng được cho GĐ1 (OpenRouter, Qdrant, secret webhook). Chỉ lưu tên, không lưu giá trị.
- Staging đang chạy 1.0.0 (deploy khoảng 9 giờ trước thời điểm khảo sát), Production chưa có.
- Schema của `timeoutMs` tool chỉ có `minimum: 1`, không có `maximum`. Giới hạn thật của Core vẫn chưa xác minh.

**Chưa xác minh được:**

- `SOTA_CORE_ORIGIN` trong `.env` local là `https://api.v4.sotaagents.ai` (Core production) và mặc định trong `sota-auth.ts` (chưa commit) cũng đã đổi sang origin này, trước đó là `api.v4.stg...`. Chưa biết service Staging trên Render đặt biến này là gì, và Core nào ký token cho môi trường Staging. Cần kiểm tra biến môi trường trên Render trước khi commit thay đổi mặc định.

**Các câu hỏi đã đặt ra (đã trả lời, xem mục 3.2):**

| # | Câu hỏi | Khuyến nghị |
|---|---|---|
| 1 | Webhook index dùng JWT, API key hay HMAC? Tenant (org/workspace) của dữ liệu index xác định thế nào khi webhook không có claims? | HMAC kèm timestamp. Tenant cố định theo deployment hoặc ánh xạ từ credential, không lấy từ body |
| 2 | Luồng 1 dùng hướng A hay B? | B (top-k), kèm `k` và ngưỡng ban đầu |
| 3 | Payload Qdrant có `content` đầy đủ hay rút gọn? Có chia chunk không? | Lưu `ideaId`, `type`, `title`, nội dung chunk, `metadata`; gom theo `ideaId` khi query |
| 4 | Embedding model nào, gọi qua OpenRouter? | Chốt một model, ghi tên model vào payload hoặc tên collection |
| 5 | BE gọi luồng 1 qua Core hay gọi thẳng Sota App? | Giữ qua Core (hiện đã chạy với JWT) |
| 6 | File đính kèm: định dạng, dung lượng tối đa, link có cần quyền không, xử lý khi không đọc được file | Không đọc được file thì vẫn index `title` + `content` và ghi cờ lỗi |

**Việc dọn nợ còn lại:** đã xác nhận (2026-11-04) `SOTA_CORE_ORIGIN` trên Render là `https://api.v4.sotaagents.ai`, khớp mặc định mới trong `sota-auth.ts`. File này vẫn chưa commit, chờ đồng ý.

### 3.2 Quyết định đã chốt (2026-11-03)

| # | Chủ đề | Quyết định |
|---|---|---|
| 1 | Auth webhook và tách dữ liệu theo workspace | Hai quyết định khác nhau. (a) Auth: ~~API key chung, giá trị bất kỳ, đặt trong env~~ **Đổi sang HMAC-SHA256 kèm timestamp ngày 2026-11-04** (dòng 11): VNAIP BE ký raw body bằng secret dùng chung (`WEBHOOK_HMAC_SECRETS`), gửi `X-Webhook-Signature`/`X-Webhook-Timestamp`; so khớp hằng thời gian, timestamp lệch quá 5 phút bị từ chối (chống replay). (b) ~~Key phân vùng `datasetKey` do BE gửi...~~ **Đã bỏ ngày 2026-11-04** (dòng 9): không tách dữ liệu theo workspace nữa |
| 2 | Luồng 1 | Hướng A: lấy tất cả ứng viên từ Qdrant rồi để LLM chấm, không embed (1) ở luồng 1 |
| 3 | Payload Qdrant | `ideaId`, `type`, `title`, nội dung chunk, `metadata`. Có chia chunk, gom theo `ideaId` khi query |
| 4 | Embedding | `openai/text-embedding-3-small` qua OpenRouter (vector 1536 chiều) |
| 5 | Đường gọi luồng 1 | Giữ BE → SotaAgents Core → Sota App (JWT) |
| 6 | File đính kèm | Không đọc được file thì vẫn index `title` + `content` và ghi cờ lỗi |
| 7 | Queue (2026-11-04, đã đổi) | **BullMQ (Redis)**, theo diagram `Final1.png`; thay cho RabbitMQ đã chọn trước đó (mã RabbitMQ đã gỡ). Worker `concurrency = 1` cộng giới hạn toàn cục bằng 1 trong Redis; retry do BullMQ giữ (`attempts` + backoff tuỳ chỉnh); job lỗi nằm ở tập `failed`. Redis: xem dòng 10 |
| 8 | File đính kèm, cập nhật theo diagram (2026-11-04) | BE gửi `fileRef`, không gửi file hay link. Worker tải file từ MinIO của VNAIP bằng quyền chỉ đọc, trích text bằng CPU, chia chunk, rồi xoá file tạm. **MinIO: `#TODO`** (VNAIP chưa có: endpoint, bucket, credential chỉ đọc, định dạng `fileRef`). Hiện event nhận `fileRef`, job mang theo, worker bỏ qua và ghi log. Giới hạn đã đồng ý từ trước (20 MB, 30 giây xử lý, 500.000 ký tự văn bản trích ra) áp dụng khi làm phần file |
| 9 | Bỏ `datasetKey` (2026-11-04) | Không tách dữ liệu theo workspace: mọi sáng kiến của VNAIP nằm chung một tập dữ liệu trong collection của môi trường. Event không cần `datasetKey` (nếu BE vẫn gửi thì bị bỏ qua). Thay quyết định #1(b). Hệ quả: xem "Điểm mở còn lại" |
| 10 | Redis (2026-11-04) | Tự host. `maxmemory-policy noeviction`. **AOF tắt** (sẽ bật nếu cần): Redis khởi động lại thì job đang chờ bị mất, nên BE phải gửi lại event chưa thấy được index (an toàn vì index idempotent theo `id`). Tách khỏi Redis cache của BE. Chưa dựng Redis thật; chưa biết có TLS không (code đang đòi `rediss://` trừ localhost) |
| 11 | Worker (2026-11-04) | Tách khỏi tiến trình web: `src/backend/worker.ts`, chạy bằng `npm run start:worker` (dev: `npm run dev:worker`). Web chỉ là producer, không cần khoá OpenRouter/Qdrant. Job mang đủ `id`, `type`, `title`, `content`, `metadata`, `fileRef` để worker không phải hỏi lại BE |
| 12 | Auth webhook đổi sang HMAC (2026-11-04) | Thay quyết định #1(a): API key tĩnh → HMAC-SHA256 trên raw body kèm timestamp (`X-Webhook-Timestamp` + `X-Webhook-Signature: sha256=<hex>`), dung sai 5 phút. Giải quyết luôn điểm mở "chống replay" đã ghi ở dòng 94/190 cũ. VNAIP BE cần đổi cách ký request |
| 13 | Vượt trần ứng viên (2026-11-04, GĐ3) | **Báo lỗi, không cắt.** Quá `CHECK_DUPLICATES_CANDIDATE_LIMIT` sáng kiến (mặc định 100, tối đa 500, tính sau khi loại `excludeIds`) hoặc kho vượt giới hạn đọc (10000 chunk) thì tool trả `503 CANDIDATE_LIMIT_EXCEEDED`. Lý do: hướng A không có độ tương đồng để xếp hạng nên cắt tuỳ ý có thể bỏ sót đúng sáng kiến trùng và trả "không trùng" sai. Mặc định 100 = 10 batch (10 ứng viên) chạy trong một đợt song song. Hệ quả: tool ngừng dùng được khi kho vượt trần, đó là tín hiệu chuyển sang hướng B (vector đã lưu sẵn). **Đây là mặc định do dev chọn, chưa được chủ sản phẩm xác nhận** |
| 14 | Giới hạn người gọi (2026-11-04, GĐ3) | Allow-list `CHECK_DUPLICATES_ALLOWED_SUBS` / `_OIDS` / `_WIDS`, chỉ so với claims đã xác thực. Đóng theo mặc định: không đặt danh sách nào thì 403 cho mọi lời gọi. Nhiều danh sách là **AND** (thu hẹp, không mở rộng quyền). Bỏ tham số tenant (`VerifiedContext`) khỏi `checkDuplicates()` vì không còn dữ liệu theo tenant |
| 15 | Model chấm điểm (2026-11-04, GĐ3) | **Chưa chốt cho Staging/production.** Hai ID chủ dự án chọn lần lượt, `anthropic/claude-3.5-sonnet` rồi `meta-llama/llama-3.3-70b-instruct:free`, **đều không còn trên OpenRouter** (đối chiếu `GET /api/v1/models`). Đã đo thật cùng 10 sáng kiến mẫu: `claude-sonnet-5.5` ~7,5 giây mỗi batch 10 (2/10 USD mỗi triệu token); `claude-haiku-5.5` 7,5 giây cho **100** sáng kiến (0,1/0,5 USD, khoảng 0,7 cent mỗi lần kiểm tra); `meta-llama/llama-3.3-70b-instruct` (trả phí, 0,1/0,32 USD) ~24 giây; `nvidia/nemotron-3.5-super-vl:free` ~42 giây; `google/gemma-4-*:free` bị 429 upstream. Chất lượng chấm điểm của cả bốn model chạy được đều chấp nhận được (cặp gần trùng 90–98%). **Chỉ Haiku 5.5 (và Sonnet cho dữ liệu nhỏ) đạt mốc 15 giây; model `:free` và Llama 3.3 70B thì không.** Máy dev của chủ dự án đang dùng `nvidia/nemotron-3.5-super-vl:free` với thời hạn nới (`CHECK_DUPLICATES_DEADLINE_MS=60000`) chỉ để thử cục bộ. Scorer luôn đặt `max_tokens` (250 token mỗi ứng viên + 300) vì thiếu nó OpenRouter tính trước 65536 token và trả 402. Mặc định batch 5 / đồng thời 20 (xem trạng thái GĐ3). **Lưu ý:** model `:free` bị giới hạn 20 request/phút và 50 request/ngày với tài khoản chưa nạp credit, trong khi mỗi lời gọi tool với 100 sáng kiến phát sinh 20 request ở cấu hình mặc định; prompt gửi tới nhà cung cấp model free còn chứa nội dung sáng kiến nội bộ nên cần kiểm tra chính sách lưu dữ liệu của nhà cung cấp trước khi dùng dữ liệu thật |
| 16 | Chuyển từ OpenRouter sang Gemini free (2026-11-05) | Scorer và embedding dùng chung `GEMINI_API_KEY` nhưng đi qua **hai endpoint khác nhau**: scorer gọi endpoint tương thích OpenAI (`https://generativelanguage.googleapis.com/v1beta/openai`, `LLM_SCORER_BASE_URL` để đổi); embedding gọi API gốc `POST /v1beta/models/{model}:batchEmbedContents` (`EMBEDDING_BASE_URL` để đổi; khoá ở header `x-goog-api-key`, số chiều ở `outputDimensionality` **cấp trên cùng của từng request** (đặt trong `embedContentConfig` thì bị bỏ qua âm thầm: HTTP 200 nhưng vẫn 3072 chiều, gây lỗi `BAD_RESPONSE` "kỳ vọng 1536, nhận 3072" khi index; đã kiểm bằng khoá thật 2026-11-05), response `embeddings[].values` theo đúng thứ tự request). Lúc đầu dùng endpoint `/embeddings` tương thích OpenAI nhưng tài liệu Gemini không nói endpoint đó có nhận `dimensions` không, nên chuyển sang API gốc theo yêu cầu của chủ dự án; dùng `:batchEmbedContents` thay `:embedContent` để một batch chunk chỉ tốn một request (free tier giới hạn request mỗi phút). `GEMINI_BASE_URL` bị bỏ vì hai endpoint cần hai base URL; `OPENROUTER_*` **không còn được đọc** (thiếu `GEMINI_API_KEY` thì `NOT_CONFIGURED`, thông báo nói rõ). `openrouter-embeddings.ts` đổi thành `embeddings.ts`. Embedding mặc định `gemini-embedding-001`, mặc định 3072 chiều nên request luôn gửi `outputDimensionality: 1536` để giữ collection Qdrant hiện có, và client tự chuẩn hoá L2 vì tài liệu nói model này không chuẩn hoá khi cắt khỏi 3072. Vector cũ (`text-embedding-3-small`) và mới nằm lẫn trong collection nhưng không so sánh được, chấp nhận được vì hướng A chỉ đọc nội dung, **phải index lại trước khi làm hướng B**. HTTP 429 của scorer tách thành `RATE_LIMITED` (trước là `NETWORK_ERROR`); bỏ mã `QUOTA_EXCEEDED` (402) của embedding vì chỉ OpenRouter có. Giữ `LLM_SCORER_BASE_URL`/`LLM_SCORER_API_KEY` (khoá của project khác có hạn mức free tier riêng) và thêm `LLM_SCORER_REASONING_EFFORT` (Gemini bật thinking mặc định, token suy nghĩ có thể làm output bị cắt). **Chưa gọi Gemini thật**: tài liệu không nêu hạn mức free tier, không nói chat có nhận `json_object`/`max_tokens` không, không nêu số request tối đa của `:batchEmbedContents` (mặc định `EMBEDDING_BATCH_SIZE=64`), và tài liệu không khớp về nơi đặt `outputDimensionality` (đã giải quyết bằng khoá thật: chỉ cấp trên cùng có tác dụng); `scripts/check-gemini.ts` kiểm các điểm này bằng khoá thật. Mặc định batch 5 / đồng thời 20 (20 request mỗi lần check) dễ vượt hạn mức free tier, **chưa chỉnh vì chưa có số liệu**. Nội dung sáng kiến gửi tới Google: cần đọc điều khoản dữ liệu của free tier trước khi dùng dữ liệu thật |
| 17 | Luồng 1 chuyển sang hướng B, top-k theo vector (2026-11-06) | **Thay quyết định #2 và #13.** Tool embed input (chia đoạn như lúc index, một request), Qdrant tìm `k` sáng kiến cùng `type` gần nhất rồi LLM chấm nội dung đầy đủ của nhóm đó. `k` mặc định **20** (`CHECK_DUPLICATES_TOP_K`, tối đa 100) theo yêu cầu của chủ dự án; biến `CHECK_DUPLICATES_CANDIDATE_LIMIT` không còn được đọc. Chi tiết: (a) so khớp theo từng đoạn của input, điểm của sáng kiến là max giữa các đoạn input và các chunk của nó (`query/groups` nhóm theo `ideaId`, cần Qdrant >= 1.11), nên hồ sơ dài không bị pha loãng; (b) `excludeIds` được loại ngay trong truy vấn (`must_not`) để không chiếm chỗ của `k`; (c) LLM luôn đọc nội dung đầy đủ của `k` sáng kiến chứ không chỉ chunk khớp, vector chỉ rút gọn tập ứng viên; (d) vector truy vấn và vector đã index phải cùng model: sáng kiến tìm được mang nhãn `embeddingModel` khác thì trả `502 CANDIDATES_UNAVAILABLE` thay vì xếp hạng sai (bỏ qua khi `EMBEDDING_MOCK_MODE=true`); (e) lỗi embedding input là `502 EMBEDDING_UNAVAILABLE`, thiếu khoá là `503 TOOL_NOT_CONFIGURED`; (f) `503 CANDIDATE_LIMIT_EXCEEDED` chỉ còn khi nội dung của `k` sáng kiến vượt 10000 chunk. **Rủi ro đã biết:** phân tích ở mục 10 khuyến nghị `k` rộng hơn (100-200) vì sáng kiến trùng ý nhưng diễn đạt khác nhiều có thể nằm ngoài top-20 và không bao giờ được LLM thấy; log `candidates_loaded` ghi `topScore`/`lastScore` để theo dõi. Chưa đo recall với dữ liệu thật |

**Hệ quả của các quyết định:**

- Hướng A không dùng vector khi truy vấn, nên embedding chỉ phục vụ luồng index. Vector vẫn được lưu để có thể chuyển sang top-k sau này mà không phải index lại.
- Hướng A gửi toàn bộ ứng viên cho LLM, nên chi phí token và độ trễ tăng theo số sáng kiến; từ khi bỏ `datasetKey` đó là toàn bộ sáng kiến của VNAIP chứ không chỉ một workspace. Tool có `timeoutMs: 30000`. Cần chấm theo batch song song, và nếu đặt trần số ứng viên thì trần đó cắt tuỳ ý (không có độ tương đồng để xếp hạng) nên có thể bỏ sót sáng kiến trùng.
- Auth webhook dùng HMAC-SHA256 kèm timestamp (2026-11-04, thay API key tĩnh): chữ ký tính trên raw body + timestamp bằng secret dùng chung, so khớp hằng thời gian (constant-time), timestamp lệch quá 5 phút bị từ chối và mỗi chữ ký chỉ nhận một lần trong cửa sổ đó (chống replay, `replay-guard.ts`). Vẫn cần chỉ nhận qua HTTPS, có rate limit, và nhiều secret phân tách bằng dấu phẩy để đổi secret không phải deploy lại code.

**Điểm mở còn lại:**

- **Không tách dữ liệu theo workspace (quyết định 2026-11-04, thay quyết định ngày 2026-11-03).** Bỏ `datasetKey`: mọi sáng kiến của VNAIP nằm chung một tập dữ liệu trong collection của môi trường. Đã gỡ khỏi code: `DatasetKeyHash`, `hashDatasetKey`, `DATASET_KEY_HASH_SECRET`, filter theo dataset (`scrollDataset` thành `scrollAll`, `deleteDataset` bỏ). Event còn mang `datasetKey` thì bị bỏ qua. Collection thử nghiệm cũ đã xoá nên không cần migrate.
- **Hệ quả cần theo dõi:**
  - Không còn lớp cách ly ở tầng lưu trữ: ai gọi được tool `check-duplicates` là thấy mọi sáng kiến của VNAIP. App cài vào nhiều workspace Sota, nên quyền gọi tool phải giới hạn bằng claims đã xác thực của Core (đúng quy tắc `CLAUDE.md`, không dùng trường từ body hay header không ký). Cách A cũ nay dùng cho việc này: chỉ chấp nhận lời gọi có claim (ví dụ `sub` của service account BE, hoặc `oid`/`wid` của VNAIP) nằm trong danh sách cho phép đặt ở env; không khớp trả 403. Tool có mô tả hiển thị cho model nên có thể được agent gọi (quyền gọi cụ thể chưa xác minh). Log tạm `invocation_accepted` (bật bằng `LOG_VERIFIED_CLAIMS=true`, chỉ ghi các claims trong allow-list, không ghi token) dùng để xem claim thật từ BE trên Staging.
  - `id` sáng kiến phải duy nhất trong toàn VNAIP: gửi lại cùng `id` là cập nhật sáng kiến đó. Hai sáng kiến khác nhau mà trùng `id` sẽ ghi đè nhau.
  - Input tool `check-duplicates` sẽ không có `datasetKey`. Schema hiện có `additionalProperties: false`, nên nếu BE đã gửi trường này khi gọi tool thì bị từ chối: BE cần ngừng gửi.
- **Trần số ứng viên** gửi cho LLM ở hướng A đã có mặc định (quyết định #13, chờ xác nhận); còn mở là ngưỡng số sáng kiến thực tế để chuyển sang hướng B, cần đo bằng dữ liệu và model thật.

### 3.3 Thay đổi theo diagram `Final1.png` (2026-11-04)

Diagram luồng index mới (file nằm ngoài repo) thay đổi các điểm sau so với những gì đã làm:

| Hạng mục | Trước | Theo diagram | Đã làm / còn lại |
|---|---|---|---|
| Queue | RabbitMQ (CloudAMQP) | BullMQ trên Redis | Đã thay `rabbitmq-queue.ts` bằng `bullmq-queue.ts`, gỡ `amqplib`, xoá URL RabbitMQ khỏi `.env`. Đã chạy thật trên Redis cục bộ; chưa có Redis hosted |
| File đính kèm | `fileLinks`, rồi "BE gửi file trực tiếp" | `fileRef` tham chiếu file trong MinIO của VNAIP; worker tải bằng quyền chỉ đọc | Event nhận `fileRef`, job mang theo, worker bỏ qua và ghi `fileSkipped`. Tải file, trích text, xoá file tạm: **`#TODO`** |
| MinIO | — | Kho file của VNAIP (hệ thống hiện có) | **`#TODO`**: VNAIP chưa có. Cần endpoint, bucket, access key và secret chỉ đọc, định dạng `fileRef`. `.env.example` có sẵn các biến `MINIO_*` để `#TODO` |
| Worker | Chạy chung tiến trình web | "trích text bằng CPU" | **Đã tách (2026-11-04)** thành tiến trình riêng `worker.ts` để việc trích text sau này không chặn webhook và `/health` |

**Đã xác nhận (2026-11-04):**

1. Không cần `datasetKey` nữa: đã gỡ khỏi code, xem "Điểm mở còn lại" ở mục 3.2.
2. Redis tự host, đặt `noeviction`, không bật AOF (sẽ bật nếu cần). Hệ quả khi không có AOF: Redis khởi động lại thì mất job đang chờ (mục 9).
3. Tách worker khỏi tiến trình web: đã làm (`worker.ts`), xem GĐ2.
4. Worker cần nhận đủ thông tin: job mang `id`, `type`, `title`, `content`, `metadata` và `fileRef` (diagram ghi gọn là `{metadata, fileRef}`).

**Còn mở:** Redis tự host có TLS không? Code đòi `rediss://` trừ localhost; nếu Redis chạy trong mạng nội bộ không TLS thì cần thêm một biến cho phép `redis://` có chủ đích.

## 4. GĐ1: Nền tảng OpenRouter và Qdrant

- [x] Embedding client qua OpenRouter (`src/backend/openrouter-embeddings.ts`): gọi `POST {baseUrl}/embeddings`, chia batch tuần tự, kiểm số chiều, phân loại lỗi có cờ `retryable`, có mock mode. Phần chat client chưa làm, chuyển sang GĐ3: `llm-scorer.ts` đang ghép URL bằng `new URL("/v1/chat/completions", baseUrl)`, với `https://openrouter.ai/api/v1` sẽ ra `https://openrouter.ai/v1/chat/completions` (mất `/api`).
- [x] Qdrant client (`src/backend/qdrant-store.ts`, REST bằng fetch): tạo collection (1536 chiều, cosine) và kiểm cấu hình nếu đã có, upsert, scroll, delete theo filter. Không làm `search` vì luồng 1 theo hướng A; thêm khi chuyển sang hướng B. Có store trong bộ nhớ (`InMemoryVectorStore`) cho test, seed và `QDRANT_MOCK_MODE`.
- [x] Gom mọi truy vấn Qdrant vào một module duy nhất (`qdrant-store.ts`; `ensureCollection()` tạo payload index cho `ideaId` và `chunkIndex`; mọi thao tác xoá đi qua `ideaFilter()` nên không có đường xoá cả collection). Bản đầu có `datasetFilter()` và `datasetKeyHash` để tách workspace; đã gỡ ngày 2026-11-04 khi bỏ `datasetKey`. Mỗi deployment (stg, prod) dùng collection riêng.
- [~] Cấu hình qua env. Code đọc env và `.env.example` đã cập nhật; secret không vào manifest, repo, log hay thông báo lỗi. Chưa khai báo `env` trong `manifest.yaml`: làm khi nối vào server (GĐ2/GĐ3), vì `sota env template --write` sẽ render lại `.env.example` từ manifest và có thể ghi đè các ghi chú hiện có.
- [x] Quy ước point ID (`pointId()` = UUID v5 từ `ideaId + chunkIndex`): Qdrant chỉ nhận số nguyên không dấu hoặc UUID. Mục 5.3 của thiết kế nói dùng `id` sáng kiến làm point ID, nhưng mục 9 lại chia nhiều chunk. Dùng UUID xác định từ `ideaId + chunkIndex`, còn `ideaId` nằm trong payload để gom nhóm và xoá theo filter. (Bản đầu có thêm `datasetKeyHash` trong tên; đã bỏ ngày 2026-11-04.)

Xong khi: unit test cho các client (có mock), tạo collection và upsert/scroll chạy được với Qdrant thật hoặc local.

Trạng thái (2026-11-04): khung đã xong và chưa nối vào `server.ts`, nên hành vi app không đổi. 79 test đạt (Node 22), typecheck, build và `sota validate` đạt. Test dùng server HTTP giả. Đã gọi OpenRouter thật cùng ngày: 3 vector 1536 chiều, độ dài L2 xấp xỉ 1, văn bản cùng chủ đề gần nhau hơn (cosine 0.677 so với 0.311), khoảng 2 giây cho một lô 3 văn bản. Đã chạy trên Qdrant Cloud thật (cluster `sa-east-1`, URL không cần `:6333`): `ensureCollection` (kể cả chạy lại), upsert (kể cả ghi lại lần hai không nhân đôi), scroll, `deleteIdea`, `deleteDataset`, và hai dataset trùng `ideaId` không lẫn nhau; collection thử nghiệm đã được xoá. **GĐ1 đạt tiêu chí "xong khi".** Script thử nghiệm nằm ngoài repo, chưa có lệnh `npm` cho việc này. (Ghi chú 2026-11-04: phần `deleteDataset` và "hai dataset không lẫn nhau" nói trên đã lỗi thời vì `datasetKey` đã bị bỏ; được kiểm lại bằng lần chạy ở GĐ2.)

## 5. GĐ2: Luồng index

- [x] Route webhook `POST /webhooks/idea-approved` (`webhook-routes.ts`): chữ ký HMAC-SHA256 qua `X-Webhook-Signature` (`sha256=<hex>` trên `${timestamp}.${rawBody}`) và `X-Webhook-Timestamp`, so sánh hằng thời gian, timestamp lệch quá 5 phút bị từ chối. Xác thực chạy **trước khi parse JSON**: header chữ ký/timestamp được kiểm tra trước khi đọc body, body đọc nguyên bytes (`express.raw`) rồi HMAC, sau đó mới parse; sai content-type trả `415`. Route mount **trước** parser JSON chung (`installBodyParsers`) nên Express tự khớp path (hoa/thường, dấu `/` cuối). Chống replay (`replay-guard.ts`): mỗi chữ ký chỉ nhận một lần trong cửa sổ 601 giây (Redis `SET NX EX`, bộ nhớ khi `QUEUE_MOCK_MODE`), gửi lại trả `409 DUPLICATE_DELIVERY`, guard lỗi trả `503` (fail closed), enqueue lỗi thì trả chỗ để gửi lại được; chưa chặn được request bị chặn trước khi tới server (cần version đơn điệu trong event). Nhận nhiều secret (`WEBHOOK_HMAC_SECRETS`) để đổi secret không ngừng nhận event; còn `WEBHOOK_API_KEYS` cũ thì log cảnh báo `webhook_legacy_api_keys_ignored` và biến này không còn được đọc. Validate event (`index-event.ts`), enqueue rồi trả `202`; queue không nhận được thì trả `503`, không bao giờ trả `202` giả. Chưa cấu hình thì trả `503 WEBHOOK_NOT_CONFIGURED` thay vì làm app sập. Hướng dẫn tích hợp gửi cho VNAIP BE (cách ký, test vector, mã lỗi, ví dụ code): `docs/webhook-vnaip-be.md`.
- [x] Idempotent khi BE gửi lại event (point ID xác định; có test gửi lại không nhân đôi).
- [x] Webhook nhận **mảng event** bên cạnh object đơn (2026-11-04, `parseIndexEvents` trong `index-event.ts`). Tối đa 50 phần tử, mảng rỗng bị từ chối; kiểm tra tất cả hoặc không gì cả (một phần tử sai thì `400` nêu chỉ số và không enqueue phần tử nào, không giữ chỗ replay); một chữ ký, một lần chống replay và giới hạn 1MB cho cả request; enqueue theo thứ tự mảng nên cùng `id` hai lần thì bản sau thắng; response mảng là `{status, count, jobs:[{id, jobId}]}`, object đơn giữ nguyên `{status, jobId}`. Enqueue lỗi giữa chừng trả `503` và trả chỗ replay, có thể đã vào hàng đợi một phần nên BE retry cả mảng (an toàn vì index idempotent). Chưa dùng `addBulk` của BullMQ (giao diện `JobQueue` chỉ có `publish` từng job); cần thì thêm `publishMany` để enqueue nguyên tử.
- [x] Queue BullMQ (Redis) chạy tuần tự (mục 3.2, dòng 7), `bullmq-queue.ts` cài giao diện `JobQueue`: worker `concurrency = 1` và giới hạn toàn cục bằng 1, publish chỉ thành công khi Redis đã lưu job (`202` đi sau đó) và có timeout riêng vì BullMQ chờ vô hạn nếu Redis chưa từng kết nối được, mất kết nối thì webhook trả 503 nhanh và tự chạy lại khi Redis sống lại, retry bằng `attempts` + backoff tuỳ chỉnh (lỗi `dead` ném `UnrecoverableError` nên vào tập `failed` ngay), job xong xoá sau 1 giờ và job lỗi xoá sau 14 ngày. Đã thử trên Redis thật cục bộ (12 test, trong đó có kịch bản Redis chết rồi sống lại). **Chưa thử trên Redis hosted** vì chưa có.
- [x] Worker (`index-job.ts`): chia chunk (`chunker.ts`), embed (mỗi chunk kèm tiêu đề), upsert, rồi mới dọn chunk thừa, nên sáng kiến không biến mất khỏi Qdrant giữa chừng và embedding lỗi thì dữ liệu cũ còn nguyên. Chạy ở tiến trình riêng (mục dưới). Phần file đính kèm xem mục `#TODO` MinIO; `fileRef` hiện được mang theo trong job và bỏ qua, log chỉ ghi `fileSkipped`.
- [x] Retry có giới hạn: lỗi `retryable` thử lại với độ trễ tăng gấp đôi (mặc định 5 lần, 10 giây đến 5 phút), lỗi khác hoặc hết số lần thì vào tập `failed` của BullMQ; log theo `jobId`, `ideaId`, mã lỗi và kết quả, không có nội dung. Chưa có cách báo kết quả về BE (câu hỏi callback #3 ở GĐ4).
- [x] Worker chạy tách khỏi tiến trình web (2026-11-04). `index-service.ts` có hai vai: `startWebhookService` (web, chỉ là producer, không cần khoá OpenRouter/Qdrant, `webhook_service_started`) và `startIndexWorker` (`worker.ts`, không mở cổng HTTP, `index_worker_started`). Thiếu cấu hình thì worker thoát mã 1 (`worker_failed`) để nền tảng báo hỏng ngay, còn web vẫn khởi động và webhook trả 503. Web và worker phải dùng cùng `REDIS_URL`, `QUEUE_PREFIX`, `QUEUE_NAME` (lệch prefix thì job nằm đó không ai xử lý) và nên cùng `INDEX_MAX_ATTEMPTS`. Triển khai: một dịch vụ thứ hai (ví dụ Render Background Worker) từ cùng repo và cùng bước build, lệnh chạy `npm run start:worker`; `sota dev` không chạy worker nên dev cục bộ chạy thêm `npm run dev:worker`. Ngoại lệ: `QUEUE_MOCK_MODE=true` dùng hàng đợi trong bộ nhớ nên web tự chạy worker trong tiến trình (chỉ cục bộ), và `worker.ts` từ chối chế độ này. Đã bỏ biến `INDEX_WORKER_ENABLED`.
- [x] Tắt êm khi nhận SIGTERM/SIGINT, cả web lẫn worker: web ngừng nhận request rồi đóng kết nối Redis; worker ngừng nhận job mới, chờ job đang chạy xong (tối đa 20 giây). Quá hạn 25 giây thì thoát cưỡng bức; job dở dang được BullMQ xếp lại (stalled) cho lần chạy sau. Đã kiểm tra trên tiến trình thật.
- [ ] **#TODO MinIO.** Tải file theo `fileRef` bằng quyền chỉ đọc, trích text bằng CPU (PDF, DOCX), chia chunk rồi xoá file tạm trên server (kể cả khi lỗi). Bị chặn vì VNAIP chưa có MinIO. Cần chốt trước: định dạng `fileRef` (khoá object, bucket hay URL?), endpoint, bucket, credential chỉ đọc. Khi làm cần: coi `fileRef` là khoá object hợp lệ chứ không phải URL tuỳ ý, giới hạn dung lượng, kiểm chữ ký file, chặn zip bomb, đặt thời hạn trích text, và chạy ở tiến trình worker riêng.

Xong khi: gửi event giả thì thấy point trong Qdrant, gửi lại event không tạo bản ghi trùng, auth sai bị từ chối.

Trạng thái (2026-11-04): đã chạy thật được từ đầu đến cuối với hai tiến trình riêng. 157 test đạt (Node 22; 7 test tích hợp chỉ chạy khi có `REDIS_TEST_URL`), typecheck, build và `sota validate` đạt. Kiểm tra đầu-cuối: web (`server.ts`, **không được cấp khoá OpenRouter/Qdrant**) → BullMQ (Redis cục bộ) → worker (`worker.ts`, tiến trình riêng) → OpenRouter thật → Qdrant Cloud thật, mỗi lần dùng tiền tố khoá và collection riêng rồi xoá. Đạt: worker thiếu cấu hình thoát mã 1; khi chưa có worker, web vẫn trả 202 và job nằm chờ trong Redis; bật worker thì nó nhặt job và ghi 5 chunk; sai key trả 401; gửi lại cùng event không nhân đôi; index lại bản rút gọn dọn còn 1 chunk; tắt worker rồi gửi event khác thì web vẫn trả 202, bật lại thì job được xử lý; hàng đợi và tập `failed` rỗng; SIGTERM tắt êm mã 0 cho cả web lẫn worker; log của cả hai không chứa khoá, `fileRef`, `datasetKey` cũ, tiêu đề hay nội dung. **Còn thiếu để đạt "xong khi" đầy đủ:** phần file/MinIO (`#TODO`), Redis tự host thật (chưa thử TLS, AOF), rate limit cho webhook (GĐ5). Lưu ý: kiểm tra đầu-cuối ở trên làm lúc webhook còn xác thực bằng API key ("sai key trả 401" là của thời đó). Sau khi đổi sang HMAC và thêm chống replay mới chạy lại test tự động và thử tay với hàng đợi/embedding/Qdrant mock; **chưa chạy lại đầu-cuối** với Redis, OpenRouter và Qdrant thật, và `RedisReplayGuard` chưa được thử trên Redis thật.

## 6. GĐ3: Luồng kiểm tra trùng mới

- [x] Thay `findVnaipCandidates` bằng truy vấn Qdrant theo hướng A (`candidate-source.ts`): `scrollAll()` toàn bộ point (không lọc theo dataset), gom chunk theo `ideaId`, chỉ lấy sáng kiến cùng `type` với input, loại `excludeIds` trong `checkDuplicates()` (không phụ thuộc adapter). Không embed (1) ở luồng này. Khi đọc trúng lúc một sáng kiến đang được index lại, lấy lần index mới nhất (`indexedAt`) làm chuẩn và bỏ chunk đuôi cũ. Scroll chạm 10000 chunk thì báo `CANDIDATE_LIMIT_EXCEEDED`, không trả dữ liệu thiếu. Lần đọc đầu gọi `ensureCollection()` nên môi trường mới chưa index gì trả `matches: []` thay vì lỗi 404.
- [x] Không thêm `datasetKey` vào `dedup-input.schema.json`; schema giữ `additionalProperties: false`, có test `datasetKey` bị từ chối (400).
- [x] Giới hạn ai được gọi tool (`caller-policy.ts`): allow-list trong env, xem quyết định #14. Chạy sau `requireSotaInvocation` (log `invocation_accepted` vẫn thấy claim của lời gọi bị từ chối). Log từ chối chỉ nêu lý do (`sub_not_allowed`...), không ghi giá trị claim. Test qua Express thật + JWT thật (JWKS giả): `check-duplicates-http.test.ts`, trong đó danh tính khai trong body hoặc header không có tác dụng. **Chưa có giá trị thật để đặt** (xem GĐ0, mục "Xác định claim nhận diện BE").
- [~] Chấm điểm theo batch chạy song song để nằm trong `timeoutMs` (`llm-scorer.ts`): mặc định batch 5 ứng viên, tối đa 20 lần gọi đồng thời, mỗi lần gọi bị cắt theo deadline chung của cả lời gọi (mặc định 28 giây, nhỏ hơn `timeoutMs: 30000`; mỗi lần gọi model tối đa 25 giây). Một batch lỗi hoặc hết giờ thì cả lời gọi trả `502 SCORING_UNAVAILABLE` và các lần gọi còn lại bị huỷ (điểm của một phần ứng viên sẽ cho "không trùng" sai ở phần còn lại). Trần ứng viên: quyết định #13. **Đã đo thật với 100 sáng kiến bằng Haiku 5.5, chưa đo bằng Sonnet 5.5** (hết credit OpenRouter), xem trạng thái.
- [x] Đổi `excludeId` thành `excludeIds` (mảng, tối đa 100 phần tử, mỗi phần tử 1..200 ký tự) ở schema, validator và code. `excludeId` số ít bị từ chối (400), nên BE phải đổi cùng lúc. Output `{matches:[{type,id,score,percent,reason}]}` giữ nguyên. `parentSolutionId` vẫn được chấp nhận nhưng chưa dùng để lọc (mô tả schema nói rõ).
- [x] LLM scorer chuyển sang OpenRouter: gọi `{OPENROUTER_BASE_URL}/chat/completions` (giữ `/api/v1`, có test hồi quy), dùng chung `OPENROUTER_API_KEY` với embedding, `temperature: 0`, **luôn đặt `max_tokens`** (xem quyết định #15), chấp nhận JSON bọc code fence (Sonnet 5.5 và Haiku 5.5 đều bọc dù có `json_object`), báo rõ khi đầu ra bị cắt (`finish_reason: length`), giữ các bước kiểm tra kết quả sẵn có (id phải thuộc ứng viên, percent hợp lệ, reason không rỗng). **Không có model mặc định**: `LLM_SCORER_MODEL` bắt buộc, thiếu thì tool trả `503 TOOL_NOT_CONFIGURED`. `LLM_MOCK_MODE` đổi từ "mặc định bật" sang "chỉ bật khi đặt `true`" như embedding và Qdrant. Đã gọi OpenRouter chat thật (xem trạng thái).
- [x] Xoá `vnaip-client.ts` và mock VNAIP; gỡ `VNAIP_*` và `LLM_SCORER_BASE_URL`/`LLM_SCORER_API_KEY` khỏi `.env.example` và README. Handler dựng dependency ở lần gọi đầu: thiếu cấu hình thì tool trả `503 TOOL_NOT_CONFIGURED` còn `/health` và webhook vẫn chạy; sửa cấu hình xong lần gọi sau chạy được mà không cần khởi động lại.
- [x] Script seed (`scripts/seed-ideas.ts` + `scripts/seed-ideas.json`, 10 sáng kiến mẫu id `SEED-GP-xxxx`, có hai cặp gần trùng và một sáng kiến nhiều chunk): đi qua đúng đường index của worker. Bắt buộc `--collection` trùng `QDRANT_COLLECTION`, từ chối collection có chữ "prod" và `QDRANT_MOCK_MODE=true`, `--clean` chỉ xoá đúng các id mẫu. Đã chạy thật trên Qdrant Cloud với collection tạm: từ chối thiếu hoặc sai `--collection` và collection `prod`, nạp 11 chunk, nạp lại không nhân đôi, `--clean` về 0 point.
- [x] Ở chế độ mock, kho trong bộ nhớ dùng chung trong một tiến trình (`createVectorStoreFromEnv`) để sáng kiến index qua webhook (worker chạy cùng tiến trình khi `QUEUE_MOCK_MODE=true`) hiện ra ở tool. Không chia sẻ được giữa web và worker chạy tiến trình riêng.

Xong khi: test giới hạn người gọi (claims không khớp bị từ chối), thời gian trả lời nằm trong 15 giây, `sota validate` và build đạt.

Trạng thái (2026-11-04): phần mã và test xong. 255 test (248 đạt, 7 bỏ qua do cần `REDIS_TEST_URL`; Node 22), typecheck mã và test, build và `sota validate` đạt. Đã chạy server thật ở chế độ mock hoàn toàn (không chạm dịch vụ ngoài): webhook ký HMAC → index → tool qua JWT giả cho kết quả đúng, `excludeIds` hoạt động, allow-list không khớp trả 403, không có allow-list trả 403 và log `caller_policy_empty`, thiếu cấu hình trả 503 còn `/health` vẫn sống, log không chứa nội dung hồ sơ.

**Chạy thật trên Qdrant Cloud + OpenRouter (2026-11-04, collection tạm đã xoá và xác nhận 404, vector giả nên không tốn phí embedding):**

- **Lỗi tìm ra và đã sửa:** scorer không đặt `max_tokens` nên OpenRouter trả `402` ("requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 3989") ở mọi lần chấm. Đã đặt `max_tokens` theo kích thước batch, thêm test.
- **Chất lượng (Sonnet 5.5, 10 sáng kiến mẫu, 1 batch):** cặp gần trùng `SEED-GP-0002`/`0001` được 97%/96%, các sáng kiến khác 10–12%, lý do hợp lý, output đúng schema. Tổng 9,0 giây, trong đó đọc Qdrant 1,5 giây (từ máy dev) nên một batch 10 ứng viên mất khoảng 7,5 giây.
- **100 sáng kiến (đúng trần mặc định), Haiku 5.5:** batch 10 / đồng thời 10 mất 9,4 và 11,5 giây (đọc Qdrant 1,6 và 2,9 giây); batch 5 / đồng thời 20 mất 7,5 giây, không bị OpenRouter giới hạn tốc độ. Đọc 101 chunk từ Qdrant Cloud mất 1,5–2,9 giây. Thời gian do độ dài đầu ra mỗi lần gọi quyết định chứ không phải số sáng kiến (các batch chạy song song), nên đã đổi mặc định sang batch 5 / đồng thời 20. **Mỗi cấu hình mới chỉ đo 1–2 lần và bằng Haiku**, chưa phải số liệu kết luận cho Sonnet.
- Vượt trần (101 sáng kiến) trả `CANDIDATE_LIMIT_EXCEEDED` ngay sau khi đọc Qdrant, không gọi model.

**Chưa đạt đủ tiêu chí "xong khi":** (1) chưa chốt được model đạt mốc 15 giây: chỉ Haiku 5.5 đạt (đo với 100 sáng kiến) nhưng cần credit, mà tài khoản OpenRouter là free tier và **credit tặng đã hết** (usage hôm nay ~0,05 USD, phần lớn do các lần chạy thử ở GĐ3 này), nên cần nạp credit (vài USD đủ cho hàng trăm lần kiểm tra) rồi đo lại bằng model đã chọn; (2) chưa có claim thật của BE nên chưa đặt được allow-list ở Staging. Còn lại ngoài tiêu chí: chưa khai báo `env` trong `manifest.yaml` (xem GĐ1, mục cấu hình qua env). **Việc phải làm khi triển khai:** Staging đang chạy bản cũ không có allow-list; bản mới trả 403 cho mọi lời gọi cho tới khi đặt `CHECK_DUPLICATES_ALLOWED_*`, và cần thêm `QDRANT_*` (cùng collection với worker), `OPENROUTER_API_KEY`, `LLM_SCORER_MODEL=anthropic/claude-sonnet-5.5` cho dịch vụ web.

## 7. GĐ4: Vòng đời dữ liệu

- [ ] Backfill một lần cho các sáng kiến đã duyệt trước đây. Script phải chạy lại được, không tạo trùng.
- [ ] Event cập nhật, thu hồi, huỷ duyệt → sửa hoặc xoá point.
- [ ] Quyết định có cần callback trạng thái index về BE không (#3).
- [ ] Phối hợp với BE chính sách hết hạn cache Redis khi dữ liệu Qdrant thay đổi.
- [ ] Xử lý khoảng trễ index: sáng kiến vừa duyệt có thể chưa tìm thấy ngay.

## 8. GĐ5: Hardening và release

- [x] Test bảo mật webhook: replay (cùng chữ ký, đồng thời, enqueue lỗi, guard lỗi), biên timestamp ±300 giây, định dạng timestamp/chữ ký, content-type, xác thực trước khi parse JSON (`webhook-routes.test.ts`).
- [ ] Test bảo mật còn lại: rate limit, người gọi tool không được phép, cross-environment, SSRF, và thử `RedisReplayGuard` trên Redis thật.
- [ ] Log có cấu trúc, health/readiness (kiểm Qdrant với timeout ngắn), theo dõi chi phí token.
- [ ] Cảnh báo khi worker không chạy hoặc hàng đợi tồn đọng (web vẫn trả 202 khi worker chết), và khi có job vào tập `failed`.
- [ ] Chỉnh ngưỡng và `k` bằng dữ liệu thật.
- [ ] Gỡ mọi `.invalid` và localhost khỏi cấu hình hosted.
- [ ] `sota validate` và build đạt, deploy stg rồi mới tới production.

## 9. Rủi ro cần theo dõi

| Rủi ro | Giai đoạn | Cách giảm |
|---|---|---|
| Không còn tách dữ liệu theo workspace: ai gọi được tool là đọc được mọi sáng kiến VNAIP | GĐ3, GĐ5 | Đã làm ở GĐ3: kiểm claims đã xác thực (danh sách cho phép trong env, đóng theo mặc định), 403 nếu không khớp, có test. Còn lại: biết claim thật của BE; xác minh quyền gọi tool của các workspace khác cài app |
| Hướng A vượt timeout 15 giây hoặc tốn token khi dữ liệu tăng | GĐ3, GĐ5 | Đã có batch song song, deadline chung và trần ứng viên báo lỗi thay vì cắt (GĐ3, quyết định #13). Còn lại: đo thời gian với model và dữ liệu thật, đặt ngưỡng số sáng kiến để chuyển sang hướng B (vector đã được lưu sẵn) |
| Đổi embedding model sau khi index | GĐ1, GĐ4 | Ghi tên model và version vào payload hoặc tên collection, cần reindex khi đổi |
| Redis tự host không bật AOF: khởi động lại là mất job đang chờ | GĐ2 | BE gửi lại event chưa thấy được index (idempotent theo `id`); bật AOF khi cần; luôn đặt `noeviction`; hàng trong bộ nhớ chỉ dùng cục bộ (`QUEUE_MOCK_MODE=true`), không bao giờ bật ở hosted |
| Webhook là điểm vào công khai, không qua Core | GĐ2, GĐ5 | HMAC-SHA256 kèm timestamp, so sánh hằng thời gian, nhiều secret để đổi secret, chống replay bằng dung sai timestamp ±5 phút cộng với việc mỗi chữ ký chỉ nhận một lần (`replay-guard.ts`; 2026-11-04, đổi từ API key); còn thiếu rate limit (GĐ5) và chưa chặn được request bị chặn trước khi tới server rồi mới replay (cần version đơn điệu trong event) |
| Web và worker cấu hình lệch (`REDIS_URL`, `QUEUE_PREFIX`, `QUEUE_NAME`) | GĐ2, GĐ5 | Job nằm trong Redis mà không ai xử lý và không có lỗi. Đặt cùng một bộ giá trị cho hai dịch vụ; cảnh báo hàng đợi tồn đọng (GĐ5) |
| Worker chết nhưng web vẫn trả 202 | GĐ2, GĐ5 | Job dồn trong Redis; `noeviction` nên khi Redis đầy thì publish lỗi và webhook trả 503. Cần theo dõi độ sâu hàng đợi và tuổi job cũ nhất (GĐ5) |
| Cache BE trả kết quả cũ | GĐ4 | Thống nhất chính sách hết hạn với BE |

## 10. TODO: input chưa được embedding khi check-duplicates (cần xem lại)

Ghi lại ngày 2026-11-05 sau khi rà code để trả lời câu hỏi "input A có được embed trước khi so sánh/chấm điểm không".

**Hiện trạng xác nhận qua code:**

- Khi gọi tool `check-duplicates`, nội dung input (title/content của ý tưởng A) **không được embed**. Route (`check-duplicates-route.ts`) chỉ dùng `DEFAULT_EMBEDDING_DIMENSIONS` (hằng số `1536`) để khai báo kích thước collection Qdrant, không gọi hàm `embed()` nào cho input.
- Luồng thật: `candidate-source.ts` gọi `store.scrollAll()` lấy **toàn bộ** chunk đã index (`with_vector: false`, không lấy vector về), gom theo `ideaId` thành candidate dạng text thuần, rồi `llm-scorer.ts` gửi text thô của input A cùng text thô của từng candidate cho LLM so sánh. Không có bước tính cosine similarity nào trong luồng đọc.
- `embed()` (trong `openrouter-embeddings.ts`) hiện chỉ được gọi ở luồng **index** (`index-job.ts:73-75`, chạy trong worker khi có webhook thêm/sửa ý tưởng) để tạo vector lưu vào Qdrant. Vector này đang "nằm chờ", chưa ai đọc lại để search.
- Đây là thiết kế có chủ đích ("hướng A", xem quyết định #2 ở mục 3.2 dòng 79 và hệ quả dòng 96-97), không phải lỗi/thiếu sót của code.

**Vì sao cần xem lại:**

- Hướng A gửi toàn bộ candidate cho LLM mỗi lần gọi → chi phí token và độ trễ tăng theo số sáng kiến. Đã có trần `CHECK_DUPLICATES_CANDIDATE_LIMIT` (mặc định 100, tối đa 500) để báo lỗi khi vượt quá, thay vì cắt ngầm và bỏ sót (xem quyết định #13, dòng 90). Đây chính là tín hiệu chuyển sang "hướng B".
- "Hướng B" (dùng Qdrant làm vector search thật: embed input A, tìm top-k gần nhất trước khi đưa cho LLM) sẽ nhanh hơn nhưng **đánh đổi độ chính xác**:
  - Rủi ro false negative ở bước lọc vector: ý tưởng trùng thật nhưng diễn đạt khác nhiều có thể bị loại trước khi LLM thấy, không có cách sửa lại sau đó. Hướng A hiện tại không có rủi ro này vì gửi hết.
  - Có file PDF đính kèm sẽ làm rủi ro này nặng hơn: nội dung dài, nhiều phần, "ý tưởng cốt lõi" dễ bị pha loãng khi tính embedding theo toàn file; nên nếu chuyển hướng B cần so theo **từng chunk nhỏ** (lấy max similarity giữa các chunk của A và candidate), không nên gộp một vector cho cả file.
  - Nếu chuyển hướng B, nên lấy top-k **rộng** (ví dụ top 100-200, không phải top 10-20) để giảm rủi ro bỏ sót, và vẫn luôn để LLM chấm lại trên text gốc — vector chỉ dùng để rút gọn, không thay thế LLM.

**Việc cần làm khi quay lại sửa:**

- [ ] Đo recall của hướng B bằng dữ liệu và model thật: tỉ lệ cặp trùng thật (đã biết) nằm trong top-`k`, ở `k` = 20 so với 50 và 100; từ đó chốt `k` và có cần ngưỡng similarity hay không. Hướng A (gửi tất cả) là chuẩn để so sánh.
- [x] Chuyển sang hướng B (2026-11-06): bước embed input (`input-embedder.ts`, gọi từ `dedup.ts`), `searchIdeas`/`scrollIdeas` trong `qdrant-store.ts` và `vector-store.ts`, `k` mặc định 20. Ngưỡng similarity **chưa** có: tool luôn lấy đủ `k` sáng kiến gần nhất, kể cả khi chúng không giống.
- [ ] Thiết kế cách embed/so khớp riêng cho nội dung PDF đính kèm (chunk nhỏ + max similarity) để không bỏ sót trùng lặp khi nội dung dài.

## 11. Việc chưa kiểm tra

- Client OpenRouter và Qdrant đã chạy thật ở GĐ1 và GĐ2 (embedding, tạo, ghi, đọc, xoá trên collection tạm). Chưa thử tải lớn (nhiều nghìn point), giới hạn tốc độ hay độ trễ khi scroll toàn bộ collection theo hướng A.
- Chưa biết claim nào của token nhận diện được service account của BE (cần log `invocation_accepted` từ Staging). Claim này giờ dùng để giới hạn ai được gọi tool.
- Test cần Node 20 trở lên; máy phát triển đang mặc định Node 18 nên phải `nvm use 22` trước khi chạy `npm test`.
- Quyền gọi tool `check-duplicates` ngoài BE (ví dụ agent trong workspace cài app) chưa được xác minh.
- Chưa đo toàn bộ lời gọi 100 sáng kiến bằng **Sonnet 5.5** hay model nào khác ngoài Haiku 5.5 (Sonnet chỉ đo 1 batch 10 ứng viên; Llama 3.3 70B và Nemotron free chỉ đo trên 10 sáng kiến). Độ trễ thay đổi theo giờ và theo nhà cung cấp phía sau OpenRouter, nên cần đo nhiều lần và ở Staging (cùng vùng với Qdrant) trước khi tin mốc 15 giây.
- Chưa thử tải lớn hơn 100 sáng kiến (đợt song song thứ hai), và chưa biết giới hạn tốc độ của tài khoản OpenRouter khi có nhiều lời gọi tool đồng thời (mỗi lời gọi có thể là 20 request song song).
- Chưa xác minh Core xử lý thế nào khi tool trả 503 `CANDIDATE_LIMIT_EXCEEDED` hoặc 403 (`failure_mode: abort`), và BE sẽ hiển thị gì cho người dùng.
