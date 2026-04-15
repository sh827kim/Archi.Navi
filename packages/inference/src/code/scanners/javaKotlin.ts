/**
 * Java/Kotlin 코드 신호 스캐너
 * 정규식 기반 패턴 매칭으로 API 노출, HTTP 호출, Kafka, DB 신호를 추출한다.
 * 설계 참조: docs/03-inference-engine.md §6.1.1
 */
import { createHash } from 'crypto';
import type { ExtractedSignal, FileScanResult } from '../codeSignalExtractor';

// ─── 패턴 정의 ────────────────────────────────────────────────────────────────

interface Pattern {
    kind: ExtractedSignal['kind'];
    regex: RegExp;
    confidence: number;
    /** 매칭 그룹에서 symbol과 metadata를 추출 (match 성공이 보장됨) */
    extract: (match: RegExpMatchArray) => { symbol: string; metadata: Record<string, unknown> };
}

const JAVA_PATTERNS: Pattern[] = [
    // API 노출 — @GetMapping/@PostMapping/... : 직접 문자열, value=, path= 속성 모두 지원
    {
        kind: 'expose',
        regex: /@(Get|Post|Put|Delete|Patch)Mapping\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']+)["']/,
        confidence: 0.8,
        extract: (m) => ({
            symbol: m[2]!,
            metadata: {
                method: m[1]!.toUpperCase(),
                annotation: `@${m[1]!}Mapping`,
                framework: 'spring',
                mappingSource: 'regex_annotation_flat',
            },
        }),
    },
    // API 노출 — @RequestMapping : 직접 문자열, value=, path=, method= 속성 지원
    {
        kind: 'expose',
        regex: /@RequestMapping\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']+)["']/,
        confidence: 0.8,
        extract: (m) => {
            // method= 속성이 있으면 추출, 없으면 'ANY'
            return {
                symbol: m[1]!,
                metadata: {
                    method: 'ANY',
                    annotation: '@RequestMapping',
                    framework: 'spring',
                    mappingSource: 'regex_annotation_flat',
                },
            };
        },
    },
    // HTTP 호출 — RestTemplate
    {
        kind: 'call',
        regex: /\brestTemplate\.\w+\(\s*["']([^"']+)["']/,
        confidence: 0.7,
        extract: (m) => ({ symbol: m[1]!, metadata: { client: 'RestTemplate' } }),
    },
    // HTTP 호출 — WebClient
    {
        kind: 'call',
        regex: /\bwebClient\b.*?\.uri\(\s*["']([^"']+)["']/,
        confidence: 0.7,
        extract: (m) => ({ symbol: m[1]!, metadata: { client: 'WebClient' } }),
    },
    // HTTP 호출 — @FeignClient(name = "service")
    {
        kind: 'call',
        regex: /@FeignClient\([^)]*name\s*=\s*["']([^"']+)["']/,
        confidence: 0.7,
        extract: (m) => ({ symbol: m[1]!, metadata: { client: 'FeignClient' } }),
    },
    // HTTP 호출 — RestClient (Spring 6.1+): restClient.get().uri("url") 또는 RestClient.create("url")
    {
        kind: 'call',
        regex: /\brestClient\b.*?\.uri\(\s*["']([^"']+)["']|RestClient\.create\(\s*["']([^"']+)["']/,
        confidence: 0.7,
        extract: (m) => ({ symbol: (m[1] || m[2])!, metadata: { client: 'RestClient' } }),
    },
    // HTTP 호출 — HttpInterface (Spring 6+): @GetExchange/@PostExchange/... 선언적 HTTP
    {
        kind: 'call',
        regex: /@(Get|Post|Put|Delete|Patch)Exchange\(\s*["']([^"']+)["']/,
        confidence: 0.8,
        extract: (m) => ({
            symbol: m[2]!,
            metadata: { client: 'HttpInterface', method: m[1]!.toUpperCase(), annotation: `@${m[1]!}Exchange` },
        }),
    },
    // Kafka 발행 — kafkaTemplate.send("topic", ...)
    {
        kind: 'produce',
        regex: /\bkafkaTemplate\.send\(\s*["']([^"']+)["']/,
        confidence: 0.7,
        extract: (m) => ({ symbol: m[1]!, metadata: { client: 'KafkaTemplate' } }),
    },
    // Kafka 수신 — @KafkaListener(topics = "topic") 또는 topics = {"t1","t2"} (다중 토픽)
    // 첫 번째 토픽은 regex로 캡처하고, 다중 토픽은 scanLines에서 extractAllKafkaTopics로 처리
    {
        kind: 'consume',
        regex: /@KafkaListener\([^)]*topics\s*=\s*\{?\s*["']([^"']+)["']/,
        confidence: 0.8,
        extract: (m) => ({ symbol: m[1]!, metadata: { annotation: '@KafkaListener' } }),
    },
    // RabbitMQ 수신 — @RabbitListener(queues = "queue") 또는 queues = {"q1","q2"} (다중 큐)
    // 첫 번째 큐는 regex로 캡처하고, 다중 큐는 scanLines에서 extractAllRabbitQueues로 처리
    {
        kind: 'consume',
        regex: /@RabbitListener\([^)]*queues\s*=\s*\{?\s*["']([^"']+)["']/,
        confidence: 0.8,
        extract: (m) => ({
            symbol: m[1]!,
            metadata: { annotation: '@RabbitListener', broker: 'rabbitmq', channelType: 'queue' },
        }),
    },
    // RabbitMQ 발행 — rabbitTemplate.convertAndSend("queue", ...) / rabbitTemplate.send("queue", ...)
    {
        kind: 'produce',
        regex: /\b(?:rabbitTemplate|amqpTemplate)\.(?:convertAndSend|send)\(\s*["']([^"']+)["']/,
        confidence: 0.7,
        extract: (m) => ({
            symbol: m[1]!,
            metadata: { client: 'RabbitTemplate', broker: 'rabbitmq', channelType: 'queue' },
        }),
    },
    // JPA 테이블 매핑 — @Table(name = "table_name")
    {
        kind: 'db_mapping',
        regex: /@Table\([^)]*name\s*=\s*["']([^"']+)["']/,
        confidence: 0.7,
        extract: (m) => ({ symbol: m[1]!, metadata: { annotation: '@Table' } }),
    },
];

// ─── Java 패키지 선언 추출 ────────────────────────────────────────────────────

/** Java/Kotlin 파일에서 패키지 이름 추출 */
function extractPackageName(content: string): string | undefined {
    const match = content.match(/^package\s+([\w.]+)/m);
    return match?.[1];
}

// ─── 다중 토픽 추출 ──────────────────────────────────────────────────────────

/** @KafkaListener의 topics = {"t1", "t2", "t3"} (배열형)에서 모든 토픽을 추출 */
function extractAllKafkaTopics(line: string): string[] {
    const topicsMatch = line.match(/@KafkaListener\([^)]*topics\s*=\s*(\{[^}]+\}|["'][^"']+["'])/);
    if (!topicsMatch) return [];
    const raw = topicsMatch[1]!;
    // 다중 토픽 배열만 여기서 처리, 단일 문자열은 일반 패턴 매칭으로 처리
    if (!raw.startsWith('{')) return [];
    return [...raw.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
}

/** @RabbitListener의 queues = {"q1", "q2"} (배열형)에서 모든 큐 이름을 추출 */
function extractAllRabbitQueues(line: string): string[] {
    const queuesMatch = line.match(/@RabbitListener\([^)]*queues\s*=\s*(\{[^}]+\}|["'][^"']+["'])/);
    if (!queuesMatch) return [];
    const raw = queuesMatch[1]!;
    // 다중 큐 배열만 여기서 처리, 단일 문자열은 일반 패턴 매칭으로 처리
    if (!raw.startsWith('{')) return [];
    return [...raw.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
}

// ─── 라인별 스캔 ─────────────────────────────────────────────────────────────

/**
 * 파일 내용을 라인별로 순회하며 패턴 매칭 (단일 라인 기준)
 * Phase 1은 대부분의 어노테이션이 한 줄로 작성됨을 가정한다.
 * 멀티라인 케이스는 Phase 2 (AST)에서 처리한다.
 */
function scanLines(lines: string[], patterns: Pattern[]): ExtractedSignal[] {
    const signals: ExtractedSignal[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;

        // KafkaListener 다중 토픽 처리: 모든 토픽을 개별 신호로 추출
        if (/@KafkaListener/.test(line)) {
            const topics = extractAllKafkaTopics(line);
            for (const topic of topics) {
                signals.push({
                    kind: 'consume',
                    symbol: topic,
                    lineStart: i + 1,
                    lineEnd: i + 1,
                    excerpt: line.trim(),
                    confidence: 0.8,
                    metadata: { annotation: '@KafkaListener' },
                });
            }
            if (topics.length > 0) continue;
        }

        // RabbitListener 다중 큐 처리: 모든 큐를 개별 신호로 추출
        if (/@RabbitListener/.test(line)) {
            const queues = extractAllRabbitQueues(line);
            for (const queue of queues) {
                signals.push({
                    kind: 'consume',
                    symbol: queue,
                    lineStart: i + 1,
                    lineEnd: i + 1,
                    excerpt: line.trim(),
                    confidence: 0.8,
                    metadata: { annotation: '@RabbitListener', broker: 'rabbitmq', channelType: 'queue' },
                });
            }
            if (queues.length > 0) continue;
        }

        for (const pattern of patterns) {
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

    return signals;
}

// ─── Java/Kotlin 스캐너 ───────────────────────────────────────────────────────

/**
 * Java/Kotlin 소스 파일에서 신호 추출
 * @param filePath - 파일 절대 경로
 * @param content - 파일 내용
 */
export function scanJavaKotlin(filePath: string, content: string): FileScanResult {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const packageName = extractPackageName(content);
    const lines = content.split('\n');
    const language = filePath.endsWith('.kt') ? 'kotlin' : 'java';

    const signals = scanLines(lines, JAVA_PATTERNS);

    // exactOptionalPropertyTypes 대응: packageName이 있을 때만 포함
    const result: FileScanResult = packageName
        ? { language, sha256, packageName, signals }
        : { language, sha256, signals };

    return result;
}

// ─── MyBatis XML 스캐너 ───────────────────────────────────────────────────────

/** SELECT SQL에서 테이블명 추출 (FROM/JOIN 절) */
function extractSelectTables(sql: string): string[] {
    const tables = new Set<string>();
    const fromMatches = [...sql.matchAll(/\bFROM\s+([a-z_][a-z0-9_]*)/gi)];
    const joinMatches = [...sql.matchAll(/\bJOIN\s+([a-z_][a-z0-9_]*)/gi)];
    for (const m of fromMatches) {
        tables.add(m[1]!.toLowerCase());
    }
    for (const m of joinMatches) {
        tables.add(m[1]!.toLowerCase());
    }
    return [...tables];
}

/** INSERT/UPDATE/DELETE SQL에서 테이블명 추출 */
function extractWriteTables(sql: string): string[] {
    const tables = new Set<string>();
    const insertMatches = [...sql.matchAll(/\bINSERT\s+INTO\s+([a-z_][a-z0-9_]*)/gi)];
    const updateMatches = [...sql.matchAll(/\bUPDATE\s+([a-z_][a-z0-9_]*)/gi)];
    const deleteMatches = [...sql.matchAll(/\bDELETE\s+FROM\s+([a-z_][a-z0-9_]*)/gi)];
    for (const m of [...insertMatches, ...updateMatches, ...deleteMatches]) {
        tables.add(m[1]!.toLowerCase());
    }
    return [...tables];
}

/**
 * MyBatis XML mapper 파일에서 신호 추출
 * SELECT → db_read, INSERT/UPDATE/DELETE → db_write
 * @param filePath - 파일 절대 경로
 * @param content - 파일 내용
 */
export function scanMyBatisXml(filePath: string, content: string): FileScanResult {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const signals: ExtractedSignal[] = [];

    const namespaceMatch = content.match(/<mapper\s+namespace="([^"]+)"/);
    const packageName = namespaceMatch?.[1];

    const lines = content.split('\n');
    let currentTag: string | null = null;
    let sqlBuffer = '';
    let tagStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;

        if (!currentTag) {
            const openMatch = line.match(/<(select|insert|update|delete)\b/i);
            if (openMatch) {
                currentTag = openMatch[1]!.toLowerCase();
                tagStartLine = i + 1;
                sqlBuffer = line;

                if (new RegExp(`</${currentTag}>`, 'i').test(line)) {
                    const tables = currentTag === 'select'
                        ? extractSelectTables(sqlBuffer)
                        : extractWriteTables(sqlBuffer);
                    const kind: ExtractedSignal['kind'] = currentTag === 'select' ? 'db_read' : 'db_write';
                    for (const table of tables) {
                        signals.push({
                            kind, symbol: table,
                            lineStart: tagStartLine, lineEnd: i + 1,
                            excerpt: line.trim(), confidence: 0.8,
                            metadata: { sqlTag: currentTag },
                        });
                    }
                    currentTag = null;
                    sqlBuffer = '';
                }
            }
        } else {
            sqlBuffer += '\n' + line;

            if (new RegExp(`</${currentTag}>`, 'i').test(line)) {
                const tables = currentTag === 'select'
                    ? extractSelectTables(sqlBuffer)
                    : extractWriteTables(sqlBuffer);
                const kind: ExtractedSignal['kind'] = currentTag === 'select' ? 'db_read' : 'db_write';

                for (const table of tables) {
                    signals.push({
                        kind, symbol: table,
                        lineStart: tagStartLine, lineEnd: i + 1,
                        excerpt: `<${currentTag}> SQL`,
                        confidence: 0.8,
                        metadata: { sqlTag: currentTag },
                    });
                }
                currentTag = null;
                sqlBuffer = '';
            }
        }
    }

    const result: FileScanResult = packageName
        ? { language: 'java', sha256, packageName, signals }
        : { language: 'java', sha256, signals };

    return result;
}
