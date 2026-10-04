import { validateText } from "@/lib/ai/tools/text-processing";
import { preprocessText } from "@/lib/ai/tools/preprocessing";

/**
 * The previous validator rejected 21+ characters outside [a-zA-Z0-9\s].
 * Continuous Chinese matched that class. These cases keep that failure
 * visible and lock the Unicode replacement.
 */
const ASCII_CENTRIC_CORRUPTION = /[^a-zA-Z0-9\s]{21,}/;

const PURE_CHINESE =
  "负责后端服务开发与性能优化推动缓存策略调整并降低接口响应时间";

const CHINESE_BULLET =
  "负责订单系统后端开发，设计缓存与异步处理机制，将核心接口平均响应时间降低72%。";

const LONG_CHINESE = [
  "负责后端服务开发与性能优化推动缓存策略调整并降低接口响应时间。",
  "在订单系统中设计缓存与异步处理机制，将核心接口平均响应时间降低百分之七十二。",
  "日常支持高并发访问并持续观察错误率变化，配合产品与测试完成发布与回滚预案。",
  "使用关系型数据库整理交易数据，补充合适索引并治理慢查询，保证高峰期服务稳定。",
  "与前端约定接口字段并编写清晰说明，减少联调往返，推动限流与降级策略落地。",
  "参与值班排障，定位超时与重试问题，整理开发规范与评审意见，保持服务边界清晰。",
].join("");

const TRADITIONAL =
  "負責後端服務開發與效能優化，改善快取策略並降低核心介面延遲。";

const PUNCTUATION = "，。；：！？（）《》“”‘’、——";

const MIXED_ENGLISH =
  "使用TypeScript、Node.js与PostgreSQL重构订单服务，接口P95延迟降低至120ms。";

const MIXED_NUMBERS = "支持日均120万次请求，错误率从1.8%降低至0.3%。";

const CV_FIELDS = [
  "姓名：张伟",
  "学校：北京大学信息科学技术学院",
  "公司：阿里巴巴集团",
  "职位：后端开发工程师",
].join("");

const JAPANESE =
  "バックエンドの性能改善を担当し、キャッシュ戦略を調整して応答時間を短縮しました。";

const KOREAN =
  "백엔드 서비스 개발과 성능 최적화를 담당하고 캐시 전략을 조정해 응답 시간을 낮췄습니다.";

const ENGLISH =
  "Backend engineer with experience building distributed services, REST APIs, PostgreSQL and Redis.";

const HAN = new RegExp("\\p{Script=Han}", "u");

const hanCount = (text: string): number =>
  [...text].filter((char) => HAN.test(char)).length;

const expectValid = (text: string) => {
  const result = validateText(text, 10, 50000);
  expect(result).toEqual({ isValid: true });
};

const expectCorrupted = (text: string) => {
  const result = validateText(text, 10, 50000);
  expect(result.isValid).toBe(false);
  expect(result.error?.code).toBe("CORRUPTED");
  expect(result.error?.details).toEqual({ maxConsecutiveSpecialChars: 20 });
};

describe("validateText Chinese and Unicode text", () => {
  it("accepts a Han run the ASCII rule rejects", () => {
    expect(PURE_CHINESE.length).toBeGreaterThan(21);
    expect(ASCII_CENTRIC_CORRUPTION.test(PURE_CHINESE)).toBe(true);
    expectValid(PURE_CHINESE);
  });

  it("accepts a Chinese resume bullet", () => {
    expect(ASCII_CENTRIC_CORRUPTION.test(CHINESE_BULLET)).toBe(true);
    expectValid(CHINESE_BULLET);
  });

  it("accepts a long Chinese paragraph without artificial spaces", () => {
    expect(LONG_CHINESE.length).toBeGreaterThanOrEqual(200);
    expect(hanCount(LONG_CHINESE)).toBeGreaterThanOrEqual(200);
    expect(LONG_CHINESE).not.toMatch(/[A-Za-z0-9 ]/);
    expect(ASCII_CENTRIC_CORRUPTION.test(LONG_CHINESE)).toBe(true);
    expectValid(LONG_CHINESE);
  });

  it("accepts Chinese punctuation, including a long punctuation run", () => {
    expect(PUNCTUATION).toContain("，。；：！？（）《》“”‘’、——");
    expectValid(`项目说明${PUNCTUATION}以上为正文`);
    expect(ASCII_CENTRIC_CORRUPTION.test(PUNCTUATION.repeat(2))).toBe(true);
    expectValid(PUNCTUATION.repeat(2));
  });

  it("accepts Chinese mixed with English", () => {
    expectValid(MIXED_ENGLISH);
  });

  it("accepts Chinese mixed with numbers", () => {
    expectValid(MIXED_NUMBERS);
  });

  it("accepts Chinese name, school, and company fields", () => {
    expectValid(CV_FIELDS);
  });

  it("accepts Traditional Chinese", () => {
    expect(hanCount(TRADITIONAL)).toBeGreaterThan(21);
    expect(ASCII_CENTRIC_CORRUPTION.test(TRADITIONAL)).toBe(true);
    expectValid(TRADITIONAL);
  });

  it("accepts Japanese kana and Korean Hangul", () => {
    expectValid(JAPANESE);
    expectValid(KOREAN);
  });

  it("accepts emoji and technical symbols inside normal text", () => {
    expectValid(`项目上线后稳定运行 ✅ 😀 团队👨‍👩‍👧‍👦继续迭代发布`);
    expectValid("熟悉 C++ / C# / Node.js / .NET 的服务开发与构建维护。");
  });

  it("still accepts a normal English resume sentence", () => {
    expect(ASCII_CENTRIC_CORRUPTION.test(ENGLISH)).toBe(false);
    expectValid(ENGLISH);
  });

  it("allows tab, newline, and carriage return inside Chinese text", () => {
    expectValid(`负责后端服务开发与性能优化\n\t推动缓存策略调整\r\n并降低接口响应时间`);
  });

  it("allows one replacement character and rejects a run of 21", () => {
    expectValid(`${PURE_CHINESE}\uFFFD${PURE_CHINESE}`);
    expectValid("\uFFFD".repeat(20));
    expectCorrupted("\uFFFD".repeat(21));
  });
});

describe("validateText corruption", () => {
  it("rejects a null and control run", () => {
    expectCorrupted("\u0000".repeat(21));
    expectCorrupted("\u0000\u0001\u0002".repeat(7));
    expectValid("\u0000\u0001\u0002".repeat(6));
  });

  it("rejects binary-like non-printable extraction", () => {
    const binary = Array.from({ length: 32 }, (_, index) =>
      String.fromCharCode(index % 8),
    ).join("");
    expectCorrupted(`订单服务${binary}接口延迟`);
  });

  it("rejects unassigned code points in a long run", () => {
    expectCorrupted("\u0378".repeat(21));
  });

  it("rejects valid Chinese wrapped around a corrupt block", () => {
    const garbage = "\u0000\u0001\u0002".repeat(7);
    expectCorrupted(`${PURE_CHINESE}${garbage}${TRADITIONAL}`);
  });

  it("rejects an isolated surrogate and accepts a real surrogate pair", () => {
    expectCorrupted(`${PURE_CHINESE}\uD800${PURE_CHINESE}`);
    expectCorrupted(`${PURE_CHINESE}\uDE00`);
    expectValid(`${PURE_CHINESE}\uD83D\uDE00`);
  });
});

describe("preprocessText continuous Chinese", () => {
  it("passes validation and returns normalized text", async () => {
    expect(LONG_CHINESE.length).toBeGreaterThanOrEqual(200);
    expect(LONG_CHINESE).not.toMatch(/[A-Za-z0-9 ]/);
    expect(ASCII_CENTRIC_CORRUPTION.test(LONG_CHINESE)).toBe(true);

    const result = await preprocessText(LONG_CHINESE);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.isValid).toBe(true);
    expect(result.data.normalizedText).toBe(LONG_CHINESE);
    expect(result.data.metadata.characterCount).toBe(LONG_CHINESE.length);
  });
});
