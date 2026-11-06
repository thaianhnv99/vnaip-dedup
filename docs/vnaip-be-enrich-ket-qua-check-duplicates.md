# Spec cho VNAIP BE: enrich & hiển thị kết quả `check-duplicates`

- **Phạm vi:** phần xử lý ở **VNAIP BE** sau khi nhận response từ tool
  `check-duplicates` (App `vnaip-dedup`), trước khi trả cho FE.
- **Không thuộc phạm vi App `vnaip-dedup`:** app chỉ trả `{id, type, score,
  percent, reason, relation, evidence}` theo `dedup-output.schema.json`. Việc enrich tên tác
  giả, chức danh, ngày đăng ký và quyết định hiển thị (badge, cắt top N) là
  trách nhiệm của VNAIP BE — vì chỉ VNAIP BE có quyền truy cập đầy đủ dữ
  liệu hồ sơ theo đúng tenant/quyền của người dùng gốc.

## 1. Input: response từ tool `check-duplicates`

```json
{
  "matches": [
    {
      "id": "GP-2026-0022", "type": "solutions", "score": 0.83, "percent": 83, "reason": "...",
      "relation": "paraphrase",
      "evidence": { "newQuote": "...", "candidateQuote": "..." }
    },
    {
      "id": "GP-2026-0051", "type": "solutions", "score": 0.62, "percent": 62, "reason": "...",
      "relation": "same_problem",
      "evidence": { "newQuote": "", "candidateQuote": "" }
    }
  ]
}
```

`relation` là một trong `copy`, `paraphrase`, `same_problem`, `same_solution_other_scope`,
`extension`, `unrelated`. `evidence` là hai đoạn trích nguyên văn (tối đa 200 ký tự) ở hồ sơ mới và
ở sáng kiến ứng viên; app đã kiểm chúng có thật trong dữ liệu, và là chuỗi rỗng khi model không trích
được. Hai field này là bổ sung (BE cũ bỏ qua được), nhưng nếu BE kiểm output bằng bản sao schema thì
phải cập nhật bản sao đó vì `additionalProperties` là `false`.

**Ngưỡng điểm:** từ khi chấm bằng prompt mới, tool chỉ trả sáng kiến có `percent >= 40` (cấu hình
`CHECK_DUPLICATES_MIN_SCORE`, 0 = trả mọi sáng kiến đã chấm), nên `matches` có thể rỗng. Ảnh hưởng tới
mục 4.

Nếu BE gửi `parentSolutionId`, sáng kiến cha (nếu nằm trong nhóm ứng viên) bị đặt `relation =
"extension"` và `percent <= 30`, nên không bị báo trùng. BE cũng có thể gửi `fileExcerpts` (đoạn trích
file đính kèm, tối đa 10 đoạn, mỗi đoạn 1..2000 ký tự).

`percent` (integer 0..100) là giá trị chuẩn do model sinh ra, dùng trực
tiếp để hiển thị badge — VNAIP BE **không cần tự tính lại** từ `score`.
`score` (0..1) chỉ là dạng suy ra (`score = percent / 100`), giữ lại để
tương thích phía dùng thang 0..1. Cả hai **không phải** kết luận trùng lặp
cuối cùng — xem mô tả trong `dedup-output.schema.json`.

## 2. Field cần hiển thị trên FE

| Field FE | Nguồn |
| --- | --- |
| Tên ý tưởng (`r.title`) | VNAIP BE tự tra cứu theo `id` trong data hồ sơ thật (DB VNAIP) |
| Badge `"80% - Rất giống"` (`r.percent` + `dupLevel(r.percent).label`) | `percent` lấy trực tiếp từ response tool (không tự tính lại); label theo bảng ngưỡng ở mục 3 |
| Tên tác giả (`r.author`) | VNAIP BE tự tra cứu theo `id` |
| Chức danh tác giả (`r.authorTitle`) | VNAIP BE tự tra cứu theo `id` |
| Loại hồ sơ (`r.type`) | Lấy từ `match.type` do tool trả (đã được app xác nhận khớp dữ liệu VNAIP, không tin theo model) |
| Ngày đăng ký (`r.date`) | VNAIP BE tự tra cứu theo `id` |

App `vnaip-dedup` không giữ `title`/`author`/`authorTitle`/`date` trong
output — các field này phải do VNAIP BE map thêm bằng `id` trả về.

## 3. `dupLevel(percent)` — ngưỡng badge

| percent | label |
| --- | --- |
| `>= 80` | "Rất giống" |
| `>= 50 && < 80` | "Giống một phần" |
| `< 50` | (không có badge / không thuộc diện cảnh báo trùng — xem mục 4 khi không còn match nào khác đạt ngưỡng) |

```js
function dupLevel(percent) {
  if (percent >= 80) return { label: 'Rất giống' };
  if (percent >= 50) return { label: 'Giống một phần' };
  return { label: null };
}
```

## 4. Quy tắc chọn danh sách hiển thị

Áp dụng theo thứ tự, trên toàn bộ `matches` đã nhận từ tool (đã sort giảm
dần theo `percent`):

1. **Nếu có ít nhất 1 match với `percent >= 80`:**
   → trả **toàn bộ** match có `percent >= 50` (không giới hạn số lượng; gồm
   cả nhóm "Rất giống" và "Giống một phần").
2. **Ngược lại, nếu có ít nhất 1 match với `percent >= 50`:**
   → trả **top 5** match có `percent` cao nhất (trong số các match `>= 50`).
3. **Ngược lại (không match nào `>= 50`):**
   → vẫn trả **top 5** match có `percent` cao nhất trong toàn bộ danh sách
   (dù `< 50`), để tham khảo. **Lưu ý:** với ngưỡng mặc định 40 của tool, danh sách này chỉ có các
   match từ 40 trở lên (có thể ít hơn 5 hoặc rỗng); muốn danh sách đủ 5 như trước thì đặt
   `CHECK_DUPLICATES_MIN_SCORE=0` ở app, hoặc chấp nhận danh sách ngắn hơn. Các match này không có badge (`label: null`
   theo mục 3) — FE tự quyết định hiển thị khác biệt với nhóm có badge
   (ví dụ không tô cảnh báo đỏ/vàng).

```js
function selectMatchesToShow(matches) {
  // matches: từ response tool check-duplicates, mỗi match có percent (0..100, integer)
  const sorted = [...matches].sort((a, b) => b.percent - a.percent);
  const hasVeryHigh = sorted.some(m => m.percent >= 80);
  const hasAtLeastHalf = sorted.some(m => m.percent >= 50);

  if (hasVeryHigh) {
    return sorted.filter(m => m.percent >= 50);
  }
  if (hasAtLeastHalf) {
    return sorted.filter(m => m.percent >= 50).slice(0, 5);
  }
  return sorted.slice(0, 5);
}
```

## 5. UNRESOLVED / cần xác nhận thêm

- Trường hợp `id` trong `match` không còn tồn tại/bị xoá ở DB VNAIP giữa lúc
  tool chấm điểm và lúc VNAIP BE enrich (race condition hiếm) — cần quy ước
  bỏ qua match đó hay báo lỗi; chưa được nghiệp vụ xác nhận.
