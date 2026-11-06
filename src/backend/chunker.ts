/**
 * Chia văn bản dài thành các chunk để embedding.
 *
 * Ưu tiên cắt theo đoạn (dòng trống), rồi theo khoảng trắng, cuối cùng mới cắt
 * cứng. Không chồng lấp (overlap): chunk chỉ để tìm sáng kiến gần input theo vector, rồi
 * được gom lại theo ideaId để model đọc nội dung đầy đủ. Luồng truy vấn (input-embedder.ts)
 * dùng đúng hàm này nên thêm overlap phải đi cùng việc index lại toàn bộ.
 *
 * text-embedding-3-small nhận tối đa 8191 token mỗi đầu vào; 2000 ký tự tiếng
 * Việt còn xa mức đó.
 */

export const DEFAULT_CHUNK_CHARS = 2000;

export function chunkText(
  text: string,
  options: { maxChars?: number } = {},
): string[] {
  const maxChars = options.maxChars ?? DEFAULT_CHUNK_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 50) {
    throw new RangeError("maxChars phải là số nguyên từ 50 trở lên");
  }

  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .flatMap((paragraph) => splitLong(paragraph, maxChars));

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const joined = current ? `${current}\n\n${paragraph}` : paragraph;
    if (joined.length <= maxChars) {
      current = joined;
    } else {
      if (current) chunks.push(current);
      current = paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLong(paragraph: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > maxChars) {
    let cut = lastWhitespaceBefore(rest, maxChars);
    if (cut < maxChars / 2) cut = maxChars;
    // Không cắt giữa một cặp surrogate (ví dụ emoji).
    if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

function lastWhitespaceBefore(text: string, limit: number): number {
  for (let index = limit; index > 0; index--) {
    if (/\s/.test(text.charAt(index))) return index;
  }
  return -1;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
