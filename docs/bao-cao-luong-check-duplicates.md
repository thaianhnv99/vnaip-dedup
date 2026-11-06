# Báo cáo: Phân tích luồng `check-duplicates` & tiến độ triển khai

> **Đã lỗi thời (2026-11-04).** Báo cáo này mô tả tool ở ngày 2026-11-02, khi ứng viên còn lấy từ VNAIP BE (mock). Từ GĐ3 ứng viên lấy từ Qdrant, đầu vào dùng `excludeIds`, có giới hạn người gọi và chấm điểm qua OpenRouter. Xem `docs/ke-hoach-phat-trien.md` (mục 6) và `README.md` để biết luồng hiện hành.

- **Người thực hiện:** _(điền tên)_
- **Ngày báo cáo:** 2026-11-02
- **Phạm vi:** App `vnaip-dedup` — tool `check-duplicates` (kiểm tra hồ sơ trùng lặp trong VNAIP)

## 1. Mục tiêu

Kiểm tra mức độ tương đồng giữa một hồ sơ đầu vào (`type` là `ideas`, `solutions` hoặc
`initiatives`) và các hồ sơ ứng viên CÙNG `type` mà caller được phép truy cập trong hệ
thống VNAIP (mỗi type một collection Qdrant riêng, không so chéo type), trả về
danh sách ứng viên kèm điểm số tương đồng (0..1) và lý do, để người dùng tránh
tạo hồ sơ trùng lặp. Tool **không** tự kết luận trùng lặp — caller (model/agent
gọi tool) chịu trách nhiệm diễn giải điểm số.

## 2. Sơ đồ luồng

```mermaid
sequenceDiagram
    actor U as User / Agent
    participant Core as SotaAgents Core
    participant App as App Backend (vnaip-dedup)
    participant VNAIP as VNAIP BE
    participant LLM as Model chấm điểm

    U->>Core: Gọi tool check-duplicates (type, title, content, excludeId?, parentSolutionId?)
    Core->>App: POST /tools/check-duplicates + invocation JWT (ký bằng khoá Core, qua JWKS)

    App->>App: Xác thực JWT (issuer, audience=appId, scope app-tools:invoke)
    Note right of App: Chỉ tin claims đã verify: iid/oid/wid/sub/scp.<br/>Không tin field tenant trong body/header.
    App->>App: Validate input theo JSON Schema (dedup-input.schema.json)

    alt Input không hợp lệ
        App-->>Core: 400 INVALID_INPUT
    else Input hợp lệ
        App->>VNAIP: Lấy candidate (type, excludeId, parentSolutionId, limit)
        Note right of VNAIP: Hiện đang MOCK (VNAIP_MOCK_MODE=true)<br/>— trả 2 candidate hard-code

        alt VNAIP lỗi/timeout
            App-->>Core: 502 CANDIDATES_UNAVAILABLE
        else Có candidate (hoặc rỗng)
            App->>LLM: Chấm điểm tương đồng input vs candidates (theo batch)
            Note right of LLM: Hiện đang MOCK (LLM_MOCK_MODE=true)<br/>— so khớp từ vựng thô, không gọi model thật

            alt Model lỗi/timeout
                App-->>Core: 502 SCORING_UNAVAILABLE
            else Model trả kết quả
                Note right of LLM: Model trả score (0..100, integer), relation, reason, evidence — chỉ cho ứng viên đạt ngưỡng.<br/>App đổi score thành percent rồi tự suy ra score = percent / 100.
                App->>App: Lọc id không thuộc candidate, percent ngoài [0,100]<br/>hoặc không phải integer, relation lạ, reason rỗng, id trùng;<br/>ép extension và percent ≤ 30 cho parentSolutionId; kiểm đoạn trích có thật;<br/>lọc percent < ngưỡng; sort theo percent giảm dần; cắt tối đa 30
                App->>App: Validate output theo JSON Schema trước khi trả
                App-->>Core: 200 { matches: [{id, type, score, percent, reason, relation, evidence}, ...] }
            end
        end
    end
    Core-->>U: Kết quả
```

## 3. Giải thích luồng (từng bước)

1. **Agent/user gọi tool** `check-duplicates` qua SotaAgents Core với input là
   hồ sơ cần kiểm tra: `type`, `title`, `content`, và tuỳ chọn `excludeId`
   (loại hồ sơ đang sửa khỏi kết quả) / `parentSolutionId` (giới hạn phạm vi).
   **Người dùng không cần tự chuẩn bị "data để so khớp"** — đó là candidate,
   được app tự lấy ở bước 3.

2. **Core gọi vào app backend** bằng request kèm **invocation JWT** ký bởi
   Core. App xác thực JWT qua JWKS (`sota-auth.ts`): kiểm `issuer`,
   `audience = appId`, thuật toán `EdDSA`, và scope `app-tools:invoke`. App
   **không có private key của Sota** — chỉ verify, không tự ký. Chỉ các claim
   đã verify (`iid`, `oid`, `wid`, `scp`, ...) được tin dùng; **không** đọc
   tenant/workspace từ request body hoặc header không ký.

3. **App validate input** theo `src/schemas/dedup-input.schema.json`. Input
   sai (thiếu field bắt buộc, sai enum type, v.v.) trả thẳng `400 INVALID_INPUT`,
   không đi tiếp.

4. **Lấy candidate từ VNAIP BE** (`vnaip-client.ts`): app gọi
   `findVnaipCandidates`, gửi `type`, `excludeId`, `parentSolutionId`, `limit`
   (mặc định 30, cấu hình qua `VNAIP_CANDIDATE_LIMIT`). Việc này dùng
   **service token riêng** (`VNAIP_BE_SERVICE_TOKEN`), hoàn toàn tách biệt với
   invocation JWT của Sota. Lỗi ở bước này (timeout, mạng, auth, response sai
   định dạng) luôn propagate thành `502 CANDIDATES_UNAVAILABLE` — **không bao
   giờ** âm thầm coi là "không có hồ sơ trùng".

5. **Chấm điểm tương đồng** (`llm-scorer.ts`): candidate được gửi theo batch
   (mặc định 10/batch) tới model, kèm system prompt nhắc rõ nội dung hồ sơ là
   **dữ liệu, không phải chỉ dẫn** (chống prompt injection từ nội dung hồ sơ
   độc hại). Prompt (`scoring-prompt.ts`) đưa cho model `newIdea` và mỗi ứng viên kèm
   `matchedChunks`, `titleSimilarity`, `contentSimilarity`. Model trả về `{matches: [{type, id,
   score, relation, reason, evidence}]}` chỉ cho ứng viên có `score >= MIN_SCORE`; `score` (integer
   0..100) được app đọc thành `percent`, giá trị chuẩn duy nhất về điểm.

6. **Lọc và chuẩn hoá kết quả** (`dedup.ts`, hàm `checkDuplicates`):
   - Bỏ match có `id` không thuộc tập candidate đã lấy ở bước 4.
   - Bỏ `percent` không phải integer hoặc ngoài khoảng `[0,100]`, `reason`
     rỗng, `id` trùng lặp.
   - Bỏ `relation` ngoài sáu giá trị cho phép.
   - Với ứng viên là `parentSolutionId`: ép `relation = "extension"`, `percent <= 30`.
   - Giữ `evidence` chỉ khi mỗi đoạn trích có nguyên văn trong dữ liệu đã đưa cho model;
     đoạn bịa hoặc bị sửa chữ thành chuỗi rỗng; cắt tối đa 200 ký tự.
   - Bỏ ứng viên có `percent` dưới ngưỡng (`CHECK_DUPLICATES_MIN_SCORE`, mặc định 40).
   - Gán lại `type` từ candidate thật (không tin `type` do model trả).
   - Suy ra `score = percent / 100` — `percent` là nguồn chuẩn, `score` chỉ
     là dạng dẫn xuất giữ lại để tương thích phía dùng thang 0..1.
   - Sort theo `percent` giảm dần, cắt tối đa 30 kết quả (theo `outputSchema`).

7. **Validate output** theo `dedup-output.schema.json` trước khi trả về, đảm
   bảo app không bao giờ trả `200` với nội dung sai hợp đồng.

## 4. Kết quả thực hành "làm thông luồng"

- Đã dựng xong **toàn bộ pipeline end-to-end** ở mức mock: gọi tool →
  xác thực JWT → validate input → lấy candidate (mock) → chấm điểm (mock) →
  lọc/chuẩn hoá → validate output → trả response.
- Xác nhận luồng lỗi hoạt động đúng: lỗi ở từng bước map đúng HTTP status
  (`400`/`502`/`500`) và không rò rỉ nội dung hồ sơ hoặc bí mật vào log.
- Có **40 test tự động** (`src/backend/__tests__/`, chạy bằng `npm test`)
  bao phủ: input hợp lệ/không hợp lệ, không có candidate, lỗi VNAIP/model
  propagate đúng, id lạ bị loại, score/reason sai bị loại, JWT hợp lệ/thiếu/
  hết hạn/sai audience/thiếu scope, wiring route đầy đủ.

## 5. Những phần còn đang là MOCK (chưa dùng dữ liệu/API thật)

| Thành phần | Trạng thái | Biến điều khiển |
| --- | --- | --- |
| Danh sách candidate từ VNAIP | Mock — 2 hồ sơ hard-code trong `vnaip-client.ts` | `VNAIP_MOCK_MODE=true` (mặc định) |
| Model chấm điểm tương đồng | Mock — so khớp từ vựng thô, không gọi LLM thật | `LLM_MOCK_MODE=true` (mặc định) |
| `service.baseUrl` / `health.url` trong `manifest.yaml` | Placeholder `.invalid`, chưa có backend hosted thật | — |

## 6. Việc còn lại trước khi tích hợp thật / lên production

1. Xác nhận cơ chế VNAIP BE gọi tool này qua SotaAgents Core bằng service
   account (endpoint, scope thật, mapping workspace ↔ tenant VNAIP).
2. API contract thật của VNAIP BE để lấy candidate (endpoint, auth
   server-to-server, filter fields, response shape, phân trang).
3. Provider/model API contract thật để chấm điểm tương đồng.
4. Xác nhận nghiệp vụ: danh sách `type` hợp lệ đầy đủ, vai trò/tính bắt buộc
   của `parentSolutionId`, số lượng `excludeId` cần hỗ trợ (một hay nhiều),
   ngưỡng hiển thị và số kết quả tối đa thật.
5. `timeoutMs` tối đa cho phép khi build artifact (hiện schema chỉ có
   `minimum`, chưa có `maximum`) — cần xác minh theo CLI/Core đang dùng.
6. Cơ chế xử lý khi tác vụ vượt giới hạn timeout, nếu cần (không giả định
   platform tự hỗ trợ async).
7. Có backend hosted thật để thay `service.baseUrl`/`health.url` placeholder
   trước khi deploy Staging/Production.

## 7. Đề xuất bước tiếp theo

- Làm việc với team VNAIP BE để xác nhận contract thật (điểm 2) — đây là
  phụ thuộc chặn tiến độ lớn nhất.
- Xác nhận provider model sẽ dùng cho chấm điểm (điểm 3) để ước lượng chi phí
  và độ trễ thật (ảnh hưởng đến `timeoutMs`, `batchSize`).
- Sau khi có 1-2 contract thật, chuyển `VNAIP_MOCK_MODE`/`LLM_MOCK_MODE` sang
  `false` theo từng phần, giữ nguyên bộ test hiện có làm regression guard.
