/**
 * Python 코드 신호 스캐너
 * 정규식 기반 패턴 매칭으로 API 노출, HTTP 호출, Kafka 신호를 추출한다.
 * 설계 참조: docs/03-inference-engine.md §6.1.3
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

const PYTHON_PATTERNS: Pattern[] = [
    // API 노출 — Flask/FastAPI: @app.route("path") 또는 @router.get("path")
    {
        kind: 'expose',
        regex: /@(app|router)\.(route|get|post|put|delete|patch)\(\s*["']([^"']+)["']/,
        confidence: 0.8,
        extract: (m) => ({
            symbol: m[3]!,
            metadata: {
                method: m[2] === 'route' ? 'ANY' : m[2]!.toUpperCase(),
                framework: 'flask/fastapi',
                via: m[1]!,
            },
        }),
    },
    // HTTP 호출 — requests.get/post/put/delete("url")
    {
        kind: 'call',
        regex: /\brequests\.(get|post|put|delete|patch|head)\(\s*["']([^"']+)["']/,
        confidence: 0.7,
        extract: (m) => ({ symbol: m[2]!, metadata: { client: 'requests', method: m[1]!.toUpperCase() } }),
    },
    // Kafka 발행 — producer.send("topic", ...) / KafkaProducer
    {
        kind: 'produce',
        regex: /\b(?:producer|KafkaProducer\(\))\s*\.send\(\s*["']([^"']+)["']/,
        confidence: 0.7,
        extract: (m) => ({ symbol: m[1]!, metadata: { client: 'KafkaProducer' } }),
    },
    // Kafka 수신 — @kafka_consumer(topic="topic")
    {
        kind: 'consume',
        regex: /@kafka_consumer\([^)]*topic\s*=\s*["']([^"']+)["']/,
        confidence: 0.8,
        extract: (m) => ({ symbol: m[1]!, metadata: { annotation: '@kafka_consumer' } }),
    },
];

// ─── Python 스캐너 ────────────────────────────────────────────────────────────

/**
 * Python 소스 파일에서 신호 추출
 * @param filePath - 파일 절대 경로 (.py)
 * @param content - 파일 내용
 */
export function scanPython(filePath: string, content: string): FileScanResult {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const lines = content.split('\n');
    const signals: ExtractedSignal[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;

        for (const pattern of PYTHON_PATTERNS) {
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

    return { language: 'python', sha256, signals };
}
