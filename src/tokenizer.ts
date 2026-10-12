// jieba 中文预分词 — FTS5 写入和查询共用

import nodejieba from 'nodejieba';
import path from 'path';
import { fileURLToPath } from 'url';

// ── 加载自定义词典（飞书等领域词） ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dictPath = path.resolve(__dirname, '..', 'custom_dict.txt');
nodejieba.load({ userDict: dictPath });

/**
 * 将文本拆分为 token 列表
 * 非 CJK 连续段（英文/数字/下划线等）保留为整词，CJK 部分交给 jieba 分词
 */
function tokenize(text: string): string[] {
  // 提取英文/数字/下划线连续段
  const nonCJK: string[] = [];
  const cjkText = text.replace(/[a-zA-Z0-9_][\w./-]*/g, (match) => {
    nonCJK.push(match);
    return ' ';
  });

  // CJK 部分用 jieba 分词
  const cjkTokens = nodejieba.cut(cjkText)
    .map(w => w.trim())
    .filter(w => w.length > 0)
    .filter(w => !/^[\s\p{P}]+$/u.test(w));

  return [...nonCJK, ...cjkTokens];
}

/**
 * 对文本进行分词，返回空格分隔的词串
 * FTS5 tokenizer 设为 simple（按空格拆 token），配合预分词实现中文词级索引
 */
export function segment(text: string): string {
  if (!text || !text.trim()) return '';
  return tokenize(text).join(' ');
}

/**
 * 对 FTS5 查询进行分词并用 OR 连接
 * 每个 token 用双引号包裹，避免 FTS5 特殊字符问题
 */
export function segmentForQuery(text: string): string {
  if (!text || !text.trim()) return '';
  return tokenize(text).map(w => `"${w}"`).join(' OR ');
}
