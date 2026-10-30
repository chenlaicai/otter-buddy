/** prose-audit 同型审计类型声明（.mjs 模块供 TS 测试 import，先例 check-pr-evidence.d.mts） */

export interface Chapter {
  name: string;
  text: string;
}

export interface Signature {
  key: string;
  hasTimeWord: boolean;
  hasQuote: boolean;
  classes: string;
}

export interface Cluster {
  signature: Signature;
  chapters: string[];
}

export interface NGram {
  phrase: string;
  chapters: string[];
  chapterCount: number;
}

export interface Tic {
  phrase: string;
  count: number;
  ratePer1k: number;
}

export interface Rhythm {
  mean: number;
  variance: number;
  cv: number;
  uniformity: boolean;
  sentenceCount: number;
}

export interface Metaphor {
  count: number;
  ratePer1k: number;
  high: boolean;
}

export interface AuditReport {
  meta: {
    chapterCount: number;
    totalChars: number;
    generatedAt: string;
  };
  openingPatterns: Cluster[];
  closingPatterns: Cluster[];
  crossChapterNGrams: NGram[];
  connectiveTics: Tic[];
  sentenceRhythm: Rhythm;
  metaphorDensity: Metaphor;
  flags: string[];
}

export declare function loadChapters(inputPath: string): Chapter[];
export declare function splitSentences(text: string): string[];
export declare function sentenceSignature(sentence: string): Signature;
export declare function clusterBySignature(
  items: Chapter[],
  getSentences: (ch: Chapter) => string[],
): Cluster[];
export declare function crossChapterNGrams(
  chapters: Chapter[],
  n?: number,
  minChapters?: number,
): NGram[];
export declare function measureConnectiveTics(text: string): Tic[];
export declare function measureSentenceRhythm(text: string): Rhythm;
export declare function measureMetaphorDensity(text: string): Metaphor;
export declare function auditChapters(
  chapters: Chapter[],
  opts?: { top?: number },
): AuditReport;
export declare function formatReport(report: AuditReport): string;
