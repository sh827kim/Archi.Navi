/**
 * 구조적 클러스터링 — 결정적 신호 4종으로 도메인 후보 슬러그를 추출하고,
 * 각 객체↔후보 쌍의 친화도(affinity)를 계산한다.
 *
 * 신호 4종 (모두 0 또는 1, 단 nameTokenJaccard 만 0~1):
 *  - pathPrefixMatch   : 객체 path 가 후보 슬러그로 시작하면 1
 *  - routePrefixMatch  : 객체 intent 의 externalPath/route 가 후보 슬러그로 시작하면 1
 *  - topicPrefixMatch  : 객체 intent 의 messageTopic 이 후보 슬러그로 시작하면 1
 *  - nameTokenJaccard  : 객체 이름 토큰(Service/Controller/Entity suffix 제거 후) ↔ 후보 토큰 Jaccard
 *
 * affinity = 4개 신호의 단순 평균. confidence 는 본 모듈의 책임이 아님 (relationCohesion 모듈 담당).
 */
import type {
    CandidateMemberScore,
    DiscoveryInputs,
    DiscoveryIntentInput,
    DiscoveryObjectInput,
} from './types';

/** 친화도 임계값 — 이 값 미만이면 후보 멤버에서 제외 (4개 중 1개 일치 = 0.25) */
export const AFFINITY_THRESHOLD = 0.25;

/** 의미 없는 객체 이름 suffix (제거 대상) */
const STRIPPABLE_NAME_SUFFIXES = [
    'service',
    'controller',
    'entity',
    'repository',
    'repo',
    'dao',
    'dto',
    'handler',
    'manager',
    'provider',
    'component',
    'module',
];

/**
 * URL/경로 앞단의 도메인이 아닌 prefix.
 * `/api/orders`, `/v1/payments`, `/rest/inventory` 같은 흔한 transport·버전 segment 가
 * 슬러그로 잡히면 서로 다른 도메인이 한 후보(`api`/`v1`)로 묶여 발견 결과가 희석된다.
 */
const NON_DOMAIN_PATH_PREFIXES = new Set([
    'api',
    'apis',
    'rest',
    'graphql',
    'gql',
    'rpc',
    'grpc',
    'public',
    'internal',
    'private',
    'app',
    'web',
]);

/** v1 / v2 / v10 처럼 "v" + 숫자 형태인지 판정 */
function isVersionSegment(segment: string): boolean {
    return /^v\d+$/i.test(segment);
}

function isNonDomainSegment(segment: string): boolean {
    return NON_DOMAIN_PATH_PREFIXES.has(segment.toLowerCase()) || isVersionSegment(segment);
}

export interface StructuralClusterCandidate {
    /** 후보 슬러그 (정규화된 소문자 — 예: "payments") */
    slug: string;
    /** UI 표시용 자동 라벨 (slug 그대로, 첫 글자 대문자) */
    autoName: string;
    /** affinity ≥ 0.25 인 멤버 점수 */
    members: CandidateMemberScore[];
    /** 강한 신호 — UI 칩으로 표시 */
    signals: {
        topPathPrefix: string | null;
        topRoutePrefix: string | null;
        topTopicPrefix: string | null;
    };
}

export interface StructuralClusteringResult {
    candidates: StructuralClusterCandidate[];
}

/**
 * 입력 객체/intent 풀에서 후보 슬러그를 수집하고 객체별 affinity 를 계산한다.
 */
export function runStructuralClustering(inputs: DiscoveryInputs): StructuralClusteringResult {
    const intentsByObject = groupIntentsByObject(inputs.intents);

    // 1. 후보 슬러그 풀 — 모든 신호 출처에서 추출
    const slugSet = new Set<string>();
    for (const obj of inputs.objects) {
        for (const slug of extractPathSlugs(obj.path)) slugSet.add(slug);
        for (const slug of extractNameSlugs(obj.name)) slugSet.add(slug);
        const intents = intentsByObject.get(obj.id) ?? [];
        for (const intent of intents) {
            for (const slug of extractIntentRouteSlugs(intent)) slugSet.add(slug);
            for (const slug of extractIntentTopicSlugs(intent)) slugSet.add(slug);
        }
    }

    // 2. 슬러그별로 객체-후보 친화도 계산
    const candidates: StructuralClusterCandidate[] = [];
    for (const slug of slugSet) {
        const memberScores: CandidateMemberScore[] = [];
        const candidateTokens = new Set([slug]);
        // 강한 신호 추적용 — 첫 매칭만 기록
        let topPathPrefix: string | null = null;
        let topRoutePrefix: string | null = null;
        let topTopicPrefix: string | null = null;

        for (const obj of inputs.objects) {
            const intents = intentsByObject.get(obj.id) ?? [];
            const pathMatch = matchPathPrefix(obj.path, slug);
            const routeMatch = matchRoutePrefix(intents, slug);
            const topicMatch = matchTopicPrefix(intents, slug);
            const nameTokens = tokenizeName(obj.name);
            const nameJaccard = jaccardSimilarity(nameTokens, candidateTokens);

            const affinity = (pathMatch + routeMatch + topicMatch + nameJaccard) / 4;
            if (affinity < AFFINITY_THRESHOLD) continue;

            memberScores.push({
                objectId: obj.id,
                pathPrefixMatch: pathMatch,
                routePrefixMatch: routeMatch,
                topicPrefixMatch: topicMatch,
                nameTokenJaccard: round3(nameJaccard),
                affinity: round3(affinity),
                // 관계 응집도는 별도 모듈에서 채움 — 이 단계에서는 0
                relationCohesion: 0,
            });

            if (pathMatch === 1 && topPathPrefix === null) {
                topPathPrefix = firstPathSegment(obj.path);
            }
            if (routeMatch === 1 && topRoutePrefix === null) {
                topRoutePrefix = pickFirstRouteMatch(intents, slug);
            }
            if (topicMatch === 1 && topTopicPrefix === null) {
                topTopicPrefix = pickFirstTopicMatch(intents, slug);
            }
        }

        if (memberScores.length === 0) continue;

        candidates.push({
            slug,
            autoName: capitalize(slug),
            members: memberScores,
            signals: {
                topPathPrefix,
                topRoutePrefix,
                topTopicPrefix,
            },
        });
    }

    // 후보 정렬 — 멤버 수 내림차순, 같으면 슬러그 사전순
    candidates.sort((a, b) => {
        if (b.members.length !== a.members.length) return b.members.length - a.members.length;
        return a.slug.localeCompare(b.slug);
    });

    return { candidates };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function groupIntentsByObject(intents: DiscoveryIntentInput[]): Map<string, DiscoveryIntentInput[]> {
    const map = new Map<string, DiscoveryIntentInput[]>();
    for (const intent of intents) {
        const list = map.get(intent.sourceObjectId) ?? [];
        list.push(intent);
        map.set(intent.sourceObjectId, list);
    }
    return map;
}

/** path 의 첫 "의미 있는" segment 를 슬러그 후보로 추출 (transport/version prefix 는 건너뜀) */
function extractPathSlugs(path: string): string[] {
    const seg = firstPathSegment(path);
    if (!seg) return [];
    const slug = normalizeSlug(seg);
    return slug.length >= 2 ? [slug] : [];
}

/** 객체 이름에서 의미 있는 토큰만 추출 (Service/Controller 등 suffix 제거) */
function extractNameSlugs(name: string): string[] {
    const tokens = tokenizeName(name);
    return Array.from(tokens).filter((t) => t.length >= 3);
}

function extractIntentRouteSlugs(intent: DiscoveryIntentInput): string[] {
    const slugs: string[] = [];
    const candidates = [intent.externalPathHint, intent.externalRoutePattern];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const seg = firstPathSegment(candidate);
        if (seg) slugs.push(normalizeSlug(seg));
    }
    return slugs.filter((s) => s.length >= 2);
}

function extractIntentTopicSlugs(intent: DiscoveryIntentInput): string[] {
    const slugs: string[] = [];
    for (const topic of intent.messageTopicHints) {
        const seg = firstTopicSegment(topic);
        if (seg) slugs.push(normalizeSlug(seg));
    }
    return slugs.filter((s) => s.length >= 2);
}

function matchPathPrefix(path: string, slug: string): 0 | 1 {
    const seg = firstPathSegment(path);
    if (!seg) return 0;
    return normalizeSlug(seg) === slug ? 1 : 0;
}

function matchRoutePrefix(intents: DiscoveryIntentInput[], slug: string): 0 | 1 {
    for (const intent of intents) {
        for (const candidate of [intent.externalPathHint, intent.externalRoutePattern]) {
            if (!candidate) continue;
            const seg = firstPathSegment(candidate);
            if (seg && normalizeSlug(seg) === slug) return 1;
        }
    }
    return 0;
}

function matchTopicPrefix(intents: DiscoveryIntentInput[], slug: string): 0 | 1 {
    for (const intent of intents) {
        for (const topic of intent.messageTopicHints) {
            const seg = firstTopicSegment(topic);
            if (seg && normalizeSlug(seg) === slug) return 1;
        }
    }
    return 0;
}

function pickFirstRouteMatch(intents: DiscoveryIntentInput[], slug: string): string | null {
    for (const intent of intents) {
        for (const candidate of [intent.externalPathHint, intent.externalRoutePattern]) {
            if (!candidate) continue;
            const seg = firstPathSegment(candidate);
            if (seg && normalizeSlug(seg) === slug) return `/${seg}`;
        }
    }
    return null;
}

function pickFirstTopicMatch(intents: DiscoveryIntentInput[], slug: string): string | null {
    for (const intent of intents) {
        for (const topic of intent.messageTopicHints) {
            const seg = firstTopicSegment(topic);
            if (seg && normalizeSlug(seg) === slug) return seg;
        }
    }
    return null;
}

function firstPathSegment(input: string): string | null {
    const segments = input.split(/[\/]/).filter((s) => s.length > 0 && !s.startsWith(':') && !s.startsWith('{'));
    // transport prefix(api, rest, …) / 버전(v1, v2) 는 도메인 슬러그가 아니므로
    // 첫 "의미 있는" segment 가 나올 때까지 건너뛴다. 모두 prefix 라면 마지막 segment 를 fallback.
    for (const segment of segments) {
        if (!isNonDomainSegment(segment)) return segment;
    }
    return segments[segments.length - 1] ?? null;
}

function firstTopicSegment(topic: string): string | null {
    // 메시지 토픽은 보통 "domain.action" 또는 "domain-action" 형태
    const segments = topic.split(/[.\-_/]/).filter((s) => s.length > 0);
    return segments[0] ?? null;
}

function normalizeSlug(input: string): string {
    return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 객체 이름을 의미 토큰으로 분해 — pascalCase / camelCase / snake_case / kebab-case 지원 */
export function tokenizeName(name: string): Set<string> {
    const tokens = name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[\s_\-./]+/)
        .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ''))
        .filter((t) => t.length >= 2)
        .filter((t) => !STRIPPABLE_NAME_SUFFIXES.includes(t));
    return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const item of a) {
        if (b.has(item)) intersection += 1;
    }
    const union = a.size + b.size - intersection;
    if (union === 0) return 0;
    return intersection / union;
}

function capitalize(s: string): string {
    if (s.length === 0) return s;
    return s[0]!.toUpperCase() + s.slice(1);
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}
