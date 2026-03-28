/**
 * Config 파일 기반 LLM 의존성 분석 프롬프트
 *
 * config 파일(application.yml, .env, bootstrap.properties 등)의 내용을
 * LLM에게 보내 어떤 외부 서비스를 호출/의존하는지 추출한다.
 * 기존 regex 파서가 놓치는 커스텀 키, 동적 URL 조합 등도 LLM이 포착 가능.
 */
import { truncateText } from './textUtils';

// ── 상수 ──────────────────────────────────────────────

/** config 파일 1개당 최대 전송 문자 수 */
export const MAX_CONFIG_CONTENT_LENGTH = 4000;

/** LLM에 전달할 known services 최대 개수 */
export const MAX_KNOWN_SERVICES = 200;

// ── 타입 ──────────────────────────────────────────────

/** LLM에 전달할 config 컨텍스트 */
export interface ConfigAnalysisContext {
    /** 분석 대상 서비스명 */
    serviceName: string;
    /** config 파일들 (path + content) */
    configFiles: Array<{ path: string; content: string }>;
    /** 워크스페이스에 등록된 서비스 목록 (매칭용) */
    knownServices: string[];
}

/** LLM 응답: 발견된 개별 의존성 */
export interface ConfigDependency {
    /** 타겟 서비스명 */
    targetService: string;
    /** 관계 타입 */
    relationType: 'call' | 'depend_on' | 'read' | 'write' | 'produce' | 'consume';
    /** 근거가 되는 config 키/값 */
    evidence: string;
    /** 확신도 0-1 */
    confidence: number;
}

/** LLM 응답: 전체 분석 결과 */
export interface ConfigAnalysisResult {
    dependencies: ConfigDependency[];
    /** LLM이 config에서 식별한 현재 서비스명 (spring.application.name 등) */
    detectedServiceName: string | null;
}

// ── 유틸 ──────────────────────────────────────────────

/** config 파일 목록을 프롬프트용 텍스트 블록으로 변환 */
function formatConfigFiles(files: Array<{ path: string; content: string }>): string {
    return files
        .map((f, i) => {
            const truncated = truncateText(f.content, MAX_CONFIG_CONTENT_LENGTH, '\n...(truncated)');
            return `### 파일 ${i + 1}: ${f.path}\n\`\`\`\n${truncated}\n\`\`\``;
        })
        .join('\n\n');
}

/** known services 목록을 프롬프트용 텍스트로 변환 */
function formatKnownServices(services: string[]): string {
    const limited = services.slice(0, MAX_KNOWN_SERVICES);
    const list = limited.map((s) => `- ${s}`).join('\n');
    if (services.length > MAX_KNOWN_SERVICES) {
        return list + `\n- ...(외 ${services.length - MAX_KNOWN_SERVICES}개)`;
    }
    return list;
}

// ── 프롬프트 빌더 ────────────────────────────────────

/**
 * Config 파일 기반 의존성 분석 프롬프트 생성
 *
 * @param context - 분석 대상 서비스 정보, config 파일 내용, 알려진 서비스 목록
 * @returns LLM에 전달할 프롬프트 문자열
 */
export function buildConfigAnalysisPrompt(context: ConfigAnalysisContext): string {
    const { serviceName, configFiles, knownServices } = context;

    const configSection = formatConfigFiles(configFiles);
    const servicesSection = formatKnownServices(knownServices);

    return `당신은 마이크로서비스 아키텍처 분석 전문가입니다.
아래 서비스의 config 파일들을 분석하여, 이 서비스가 의존하는 외부 서비스를 추출해주세요.

## 분석 대상
- 서비스명: ${serviceName}

## Config 파일 내용
${configSection}

## 워크스페이스 등록 서비스 목록
다음은 이 워크스페이스에 등록된 서비스들입니다. 가능한 한 아래 목록과 매칭해주세요.
목록에 없는 외부 서비스(DB, 메시지 큐, 외부 API 등)도 발견되면 포함해주세요.

${servicesSection}

## 분석 지침
1. URL, 호스트, 포트, 서비스 디스커버리 설정에서 외부 서비스 참조를 찾으세요.
2. 다음 패턴들을 확인하세요:
   - Spring Cloud / Eureka / Consul 서비스 디스커버리 설정
   - Feign client, Ribbon, Gateway route 설정
   - 데이터베이스 연결 (JDBC URL, Redis, MongoDB 등)
   - 메시지 브로커 (Kafka topic, RabbitMQ exchange/queue)
   - gRPC 채널 설정
   - 환경변수 기반 URL (${"${SERVICE_URL}"} 형태)
   - 커스텀 서비스 URL/호스트 설정
3. 테스트용 설정(test profile, mock)은 제외하세요.
4. 현재 서비스 자체(${serviceName})는 의존 대상에 포함하지 마세요.
5. config에서 현재 서비스명을 감지할 수 있으면(spring.application.name 등) detectedServiceName에 기록하세요.

## 관계 타입 정의
- call: REST/gRPC 등으로 동기 호출
- depend_on: 서비스 디스커버리/설정에 의한 일반 의존
- read: 데이터 저장소에서 읽기
- write: 데이터 저장소에 쓰기
- produce: 메시지/이벤트 발행
- consume: 메시지/이벤트 구독

## 응답 형식 (JSON)
{
  "dependencies": [
    {
      "targetService": "<서비스명 또는 인프라 컴포넌트명>",
      "relationType": "call" | "depend_on" | "read" | "write" | "produce" | "consume",
      "evidence": "<근거가 되는 config 키=값 또는 설정 내용 발췌>",
      "confidence": <0.0 ~ 1.0>
    }
  ],
  "detectedServiceName": "<config에서 발견된 서비스명 또는 null>"
}

의존성이 없으면 dependencies를 빈 배열로 반환하세요.`;
}
