/**
 * TypeScript/JavaScript 코드 신호 스캐너
 * 정규식 기반 패턴 매칭으로 API 노출, HTTP 호출 신호를 추출한다.
 * 설계 참조: docs/03-inference-engine.md §6.1.2
 */
import { createHash } from 'crypto';
import type { ExtractedSignal, FileScanResult } from '../codeSignalExtractor';

// ─── 패턴 정의 ────────────────────────────────────────────────────────────────

interface Pattern {
    kind: ExtractedSignal['kind'];
    regex: RegExp;
    confidence: number;
    extract: (match: RegExpMatchArray) => { symbol: string; metadata: Record<string, unknown> };
}

const TS_PATTERNS: Pattern[] = [
    // API 노출 — Express: (app|router).(get|post|put|delete|patch)("path", ...)
    {
        kind: 'expose',
        regex: /\b(app|router)\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/,
        confidence: 0.8,
        extract: (m) => ({
            symbol: m[3] ?? '',
            metadata: { method: (m[2] ?? '').toUpperCase(), framework: 'express', via: m[1] ?? '' },
        }),
    },
    // HTTP 호출 — fetch("url") 또는 fetch('url')
    {
        kind: 'call',
        regex: /\bfetch\(\s*["']([^"']+)["']/,
        confidence: 0.7,
        extract: (m) => ({ symbol: m[1] ?? '', metadata: { client: 'fetch' } }),
    },
    // HTTP 호출 — axios.get/post/put/delete("url")
    {
        kind: 'call',
        regex: /\baxios\.\w+\(\s*["']([^"']+)["']/,
        confidence: 0.7,
        extract: (m) => ({ symbol: m[1] ?? '', metadata: { client: 'axios' } }),
    },
    // HTTP 호출 — .get/.post/.put/.delete("url") (일반 HTTP 클라이언트 체인)
    // URL/경로 형태(/, http)로 시작하는 문자열만 매칭하여 map.get(), cache.delete() 등 false positive 방지
    {
        kind: 'call',
        regex: /\.(get|post|put|delete|patch)\(\s*["']((?:\/|https?:\/\/)[^"'`]*?)["']\s*[,)]/,
        confidence: 0.6,
        extract: (m) => ({ symbol: m[2] ?? '', metadata: { method: (m[1] ?? '').toUpperCase(), client: 'http-chain' } }),
    },
];

// ─── TypeScript/JS 스캐너 ─────────────────────────────────────────────────────

/**
 * TypeScript/JavaScript 소스 파일에서 신호 추출
 * @param filePath - 파일 절대 경로 (.ts, .tsx, .js, .jsx)
 * @param content - 파일 내용
 */
export function scanTypeScript(filePath: string, content: string): FileScanResult {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const lines = content.split('\n');
    const signals: ExtractedSignal[] = [];

    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const language = ext === 'ts' || ext === 'tsx' ? 'typescript' : 'javascript';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';

        for (const pattern of TS_PATTERNS) {
            const match = line.match(pattern.regex);
            if (match) {
                const extracted = pattern.extract(match);

                signals.push({
                    kind: pattern.kind,
                    symbol: extracted.symbol,
                    lineStart: i + 1,
                    lineEnd: i + 1,
                    excerpt: line.trim(),
                    confidence: pattern.confidence,
                    metadata: extracted.metadata,
                });
                break;
            }
        }
    }

    return { language, sha256, signals };
}
