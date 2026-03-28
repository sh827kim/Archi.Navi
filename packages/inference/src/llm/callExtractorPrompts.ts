/**
 * 소스코드 기반 LLM 호출 추출 프롬프트
 *
 * consumer 서비스의 소스코드를 LLM에게 보내
 * 어떤 서비스의 어떤 엔드포인트를 호출하는지 추출한다.
 * HTTP 클라이언트 사용 파일만 프리필터링해 전달하므로 토큰 효율적.
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

/** LLM에 전달할 소스코드 컨텍스트 */
export interface CallExtractionContext {
    /** 분석 대상 서비스명 (호출하는 쪽) */
    serviceName: string;
    /** 소스 파일들 (이미 프리필터된 HTTP client 관련 파일만) */
    sourceFiles: Array<{ path: string; content: string }>;
    /** 타겟 서비스와 해당 엔드포인트 목록 (OpenAPI에서 가져온 것) */
    targetEndpoints: Array<{
        serviceName: string;
        endpoints: Array<{ method: string; path: string }>;
    }>;
}

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
 * 소스 파일 목록을 전체 길이 제한 내에서 프롬프트용 텍스트로 변환
 * 총 길이가 MAX_TOTAL_SOURCE_LENGTH를 초과하면 뒤쪽 파일을 생략
 */
function formatSourceFiles(files: Array<{ path: string; content: string }>): string {
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

/** 타겟 엔드포인트 목록을 프롬프트용 텍스트로 변환 */
function formatTargetEndpoints(
    targets: Array<{ serviceName: string; endpoints: Array<{ method: string; path: string }> }>
): string {
    return targets
        .map((target) => {
            const limited = target.endpoints.slice(0, MAX_ENDPOINTS_PER_SERVICE);
            const endpointList = limited
                .map((ep) => `  - ${ep.method.toUpperCase()} ${ep.path}`)
                .join('\n');
            const suffix =
                target.endpoints.length > MAX_ENDPOINTS_PER_SERVICE
                    ? `\n  - ...(외 ${target.endpoints.length - MAX_ENDPOINTS_PER_SERVICE}개)`
                    : '';
            return `#### ${target.serviceName}\n${endpointList}${suffix}`;
        })
        .join('\n\n');
}

// ── 프롬프트 빌더 ────────────────────────────────────

/**
 * 소스코드 기반 호출 추출 프롬프트 생성
 *
 * @param context - 분석 대상 서비스 소스코드와 타겟 엔드포인트 정보
 * @returns LLM에 전달할 프롬프트 문자열
 */
export function buildCallExtractionPrompt(context: CallExtractionContext): string {
    const { serviceName, sourceFiles, targetEndpoints } = context;

    const sourceSection = formatSourceFiles(sourceFiles);
    const endpointsSection = formatTargetEndpoints(targetEndpoints);

    return `당신은 마이크로서비스 소스코드 분석 전문가입니다.
아래 서비스의 소스코드를 분석하여, 다른 서비스의 어떤 엔드포인트를 호출하는지 추출해주세요.

## 분석 대상
- 서비스명 (호출자): ${serviceName}

## 소스코드
${sourceSection}

## 타겟 서비스 엔드포인트 목록 (OpenAPI 기반)
다음은 호출 대상 후보 서비스들의 엔드포인트입니다. 소스코드의 HTTP 호출을 아래 엔드포인트와 매칭해주세요.

${endpointsSection}

## 분석 지침
1. 소스코드에서 외부 HTTP/gRPC 호출 패턴을 모두 찾으세요:
   - Spring FeignClient (@FeignClient 인터페이스의 @GetMapping, @PostMapping 등)
   - RestTemplate (getForObject, postForEntity, exchange 등)
   - WebClient (WebClient.builder(), .get(), .post() 체인)
   - HttpClient / OkHttp / Apache HttpClient
   - 커스텀 HTTP 래퍼/유틸 클래스
   - Retrofit 인터페이스
2. 발견된 호출의 URL/경로를 위 타겟 엔드포인트 목록과 매칭하세요.
   - 경로 파라미터가 다르더라도 패턴이 매칭되면 포함 (예: /users/{id} ↔ /users/\\$\\{userId\\})
   - 정확한 매칭이 안 되면 가장 유사한 엔드포인트에 낮은 confidence로 매칭
3. 타겟 목록에 없는 외부 호출도 발견되면 포함하되 confidence를 낮게 설정하세요.
4. 테스트 코드, mock 설정, 주석 내 URL은 제외하세요.
5. 각 호출마다 근거 코드를 evidence에 간결하게 인용하세요 (1~3줄).

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
