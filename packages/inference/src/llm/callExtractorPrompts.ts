/**
 * Pair-scoped evidence pack 기반 LLM 호출 추출 프롬프트
 *
 * consumer -> provider 서비스 쌍 단위 evidence pack을 LLM에 전달해
 * 특정 provider endpoint 호출을 추출한다.
 */
import { truncateText } from './textUtils';

// ── 상수 ──────────────────────────────────────────────

/** 소스 파일 1개당 최대 전송 문자 수 */
export const MAX_SOURCE_CONTENT_LENGTH = 6000;

/** 전체 소스 파일 최대 전송 문자 수 (모든 파일 합산) */
export const MAX_TOTAL_SOURCE_LENGTH = 30000;

/** 타겟 엔드포인트 목록 최대 개수 (서비스당) */
export const MAX_ENDPOINTS_PER_SERVICE = 100;

// ── 타입 ──────────────────────────────────────────────

export interface EvidenceFile {
    path: string;
    content: string;
}

export interface ConfigSnippet {
    path: string;
    snippet: string;
}

/** pair-scoped evidence pack 컨텍스트 */
export interface PairCallExtractionContext {
    /** 호출자 서비스명 */
    consumerServiceName: string;
    /** 호출 대상(제공자) 서비스명 */
    providerServiceName: string;
    /** consumer 측 evidence 파일 묶음 */
    consumerEvidenceFiles: EvidenceFile[];
    /** provider 측 evidence 파일 묶음 */
    providerEvidenceFiles: EvidenceFile[];
    /** pair 관련 설정 snippet */
    configSnippets: ConfigSnippet[];
    /** target provider endpoint 목록 */
    targetProviderEndpoints: Array<{ method: string; path: string }>;
}

/**
 * Legacy 컨텍스트.
 * 기존 호출부가 한 번에 깨지지 않도록 허용하되, 프롬프트는 pair 포맷으로 변환해 생성한다.
 */
interface LegacyCallExtractionContext {
    serviceName: string;
    sourceFiles: EvidenceFile[];
    targetEndpoints: Array<{
        serviceName: string;
        endpoints: Array<{ method: string; path: string }>;
    }>;
}

export type CallExtractionContext = PairCallExtractionContext | LegacyCallExtractionContext;

/** LLM 응답: 발견된 개별 호출 */
export interface ExtractedCall {
    /** 호출 대상 서비스명 */
    targetService: string;
    /** HTTP 메서드 */
    httpMethod: string;
    /** 엔드포인트 경로 */
    path: string;
    /** 소스 파일 경로 */
    sourceFile: string;
    /** 근거 코드 조각 */
    evidence: string;
    /** 확신도 0-1 */
    confidence: number;
}

/** LLM 응답: 전체 추출 결과 */
export interface CallExtractionResult {
    calls: ExtractedCall[];
}

// ── 유틸 ──────────────────────────────────────────────

/**
 * evidence 파일 목록을 전체 길이 제한 내에서 프롬프트용 텍스트로 변환
 * 총 길이가 MAX_TOTAL_SOURCE_LENGTH를 초과하면 뒤쪽 파일을 생략
 */
function formatEvidenceFiles(files: EvidenceFile[]): string {
    if (files.length === 0) return '(없음)';

    const blocks: string[] = [];
    let totalLength = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const truncated = truncateText(file.content, MAX_SOURCE_CONTENT_LENGTH, '\n// ...(truncated)');
        const block = `### 파일 ${i + 1}: ${file.path}\n\`\`\`\n${truncated}\n\`\`\``;

        if (totalLength + block.length > MAX_TOTAL_SOURCE_LENGTH && blocks.length > 0) {
            blocks.push(`\n(... 나머지 ${files.length - i}개 파일 생략)`);
            break;
        }

        blocks.push(block);
        totalLength += block.length;
    }

    return blocks.join('\n\n');
}

function formatConfigSnippets(snippets: ConfigSnippet[]): string {
    if (snippets.length === 0) return '(없음)';

    return snippets
        .map((item, i) => {
            const truncated = truncateText(item.snippet, MAX_SOURCE_CONTENT_LENGTH, '\n# ...(truncated)');
            return `### Config ${i + 1}: ${item.path}\n\`\`\`\n${truncated}\n\`\`\``;
        })
        .join('\n\n');
}

/** pair 타겟 endpoint 목록을 프롬프트용 텍스트로 변환 */
function formatTargetEndpoints(endpoints: Array<{ method: string; path: string }>): string {
    if (endpoints.length === 0) return '(없음)';

    const limited = endpoints.slice(0, MAX_ENDPOINTS_PER_SERVICE);
    const endpointList = limited
        .map((ep) => `  - ${ep.method.toUpperCase()} ${ep.path}`)
        .join('\n');
    const suffix =
        endpoints.length > MAX_ENDPOINTS_PER_SERVICE
            ? `\n  - ...(외 ${endpoints.length - MAX_ENDPOINTS_PER_SERVICE}개)`
            : '';
    return `${endpointList}${suffix}`;
}

function toPairContext(context: CallExtractionContext): PairCallExtractionContext {
    if ('consumerServiceName' in context) {
        return context;
    }

    const primaryTarget = context.targetEndpoints[0];
    return {
        consumerServiceName: context.serviceName,
        providerServiceName: primaryTarget?.serviceName ?? 'unknown-provider',
        consumerEvidenceFiles: context.sourceFiles,
        providerEvidenceFiles: [],
        configSnippets: [],
        targetProviderEndpoints: primaryTarget?.endpoints ?? [],
    };
}

// ── 프롬프트 빌더 ────────────────────────────────────

/**
 * pair-scoped evidence pack 기반 호출 추출 프롬프트 생성
 *
 * @param context - consumer/provider evidence pack + target endpoint 정보
 * @returns LLM에 전달할 프롬프트 문자열
 */
export function buildCallExtractionPrompt(context: CallExtractionContext): string {
    const pair = toPairContext(context);
    const {
        consumerServiceName,
        providerServiceName,
        consumerEvidenceFiles,
        providerEvidenceFiles,
        configSnippets,
        targetProviderEndpoints,
    } = pair;

    const consumerSection = formatEvidenceFiles(consumerEvidenceFiles);
    const providerSection = formatEvidenceFiles(providerEvidenceFiles);
    const configSection = formatConfigSnippets(configSnippets);
    const endpointsSection = formatTargetEndpoints(targetProviderEndpoints);

    return `당신은 마이크로서비스 소스코드 분석 전문가입니다.
아래 consumer -> provider 서비스 쌍의 evidence pack을 분석해
provider의 어떤 endpoint를 호출하는지 추출해주세요.

## 호출자 / 대상 서비스 (Caller / Provider)
- 호출자 서비스명: ${consumerServiceName}
- 대상 서비스명: ${providerServiceName}

## Consumer Evidence Files
${consumerSection}

## Provider Evidence Files
${providerSection}

## Pair Config Snippets
${configSection}

## Target Provider Endpoint List
${endpointsSection}

## 분석 지침
1. consumer evidence를 기준으로 provider endpoint 호출을 찾으세요.
2. provider evidence와 endpoint 목록을 사용해 method/path를 최대한 정확히 매칭하세요.
3. config snippet에 있는 base URL, host, path prefix를 경로 해석에 반영하세요.
4. 외부 HTTP/gRPC 호출 패턴을 모두 탐지하세요:
   - Spring FeignClient (@FeignClient 인터페이스의 @GetMapping, @PostMapping 등)
   - RestTemplate (getForObject, postForEntity, exchange 등)
   - WebClient (WebClient.builder(), .get(), .post() 체인)
   - HttpClient / OkHttp / Apache HttpClient
   - 커스텀 HTTP 래퍼/유틸 클래스
   - Retrofit 인터페이스
5. 발견된 호출의 URL/경로를 target provider endpoint 목록과 매칭하세요.
   - 경로 파라미터가 다르더라도 패턴이 매칭되면 포함 (예: /users/{id} ↔ /users/\\$\\{userId\\})
   - 정확한 매칭이 안 되면 가장 유사한 엔드포인트에 낮은 confidence로 매칭
6. 테스트 코드, mock 설정, 주석 내 URL은 제외하세요.
7. 각 호출마다 근거 코드를 evidence에 간결하게 인용하세요 (1~3줄).

## 응답 형식 (JSON)
{
  "calls": [
    {
      "targetService": "<호출 대상 서비스명>",
      "httpMethod": "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
      "path": "<엔드포인트 경로 (예: /api/users/{id})>",
      "sourceFile": "<호출이 발견된 소스 파일 경로>",
      "evidence": "<근거 코드 1~3줄 인용>",
      "confidence": <0.0 ~ 1.0>
    }
  ]
}

호출이 없으면 calls를 빈 배열로 반환하세요.`;
}
