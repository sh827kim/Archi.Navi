/**
 * 클러스터 Label 자동 추출 (1-6)
 * 클러스터 멤버명의 토큰 빈도 분석 → 상위 N개 후보 생성
 *
 * 설계 참조: 03-inference-engine.md §4.5 Label Suggestion
 */

export interface LabelCandidate {
    text: string;
    /** 0~1 (token 빈도 / 전체 토큰 수) */
    score: number;
}

/** 너무 일반적이어서 라벨로 의미 없는 단어 목록 */
const STOP_WORDS = new Set([
    'service', 'api', 'app', 'server', 'client', 'handler', 'manager',
    'controller', 'repository', 'repo', 'impl', 'base', 'utils', 'util',
    'helper', 'module', 'component', 'provider', 'factory', 'adapter',
    'gateway', 'proxy', 'hub', 'node', 'cluster', 'discovered',
    'db', 'database', 'table', 'tables', 'topic', 'broker', 'kafka',
    'svc', 'ms', 'be', 'fe', 'web', 'core', 'common', 'shared',
    'main', 'default', 'new', 'old', 'v1', 'v2', 'v3',
]);

/**
 * 이름 → 토큰 배열
 * - PascalCase/camelCase 분리: `OrderService` → `['order', 'service']`
 * - 구분자(`-`, `_`, `.`, `:`, ` `) 분리
 * - 소문자 변환, 2자 미만 제거, STOP_WORDS 필터
 */
function tokenize(name: string): string[] {
    // discovered: prefix 제거 (Discovery로 생성된 이름)
    const cleaned = name.startsWith('discovered:') ? name.slice('discovered:'.length) : name;

    // camelCase/PascalCase → 하이픈 삽입 후 소문자 변환
    const normalized = cleaned
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .toLowerCase();

    // 구분자로 분리
    return normalized
        .split(/[-_.:\s/]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * 클러스터 멤버 이름에서 라벨 후보 추출
 * @param memberNames 클러스터에 속한 object들의 name 목록
 * @param topN 반환할 최대 후보 수 (기본 3)
 * @returns 빈도 내림차순 상위 topN 후보
 */
export function extractLabelCandidates(
    memberNames: string[],
    topN = 3,
): LabelCandidate[] {
    if (memberNames.length === 0) return [];

    const freq = new Map<string, number>();
    let totalCount = 0;

    for (const name of memberNames) {
        const tokens = tokenize(name);
        for (const token of tokens) {
            freq.set(token, (freq.get(token) ?? 0) + 1);
            totalCount++;
        }
    }

    if (totalCount === 0) return [];

    return [...freq.entries()]
        .sort(([ta, a], [tb, b]) => {
            if (b !== a) return b - a;
            return ta.localeCompare(tb);
        })
        .slice(0, topN)
        .map(([text, count]) => ({
            text,
            score: Math.round((count / totalCount) * 100) / 100,
        }));
}
