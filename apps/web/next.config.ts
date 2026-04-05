/**
 * Next.js 16 설정
 * Local-first 환경 + 모노레포 패키지 지원
 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 모노레포 workspace 패키지 트랜스파일
  transpilePackages: [
    '@archi-navi/ui',
    '@archi-navi/shared',
    '@archi-navi/db',
    '@archi-navi/core',
    '@archi-navi/inference',
  ],
  // embedded-postgres는 서버 런타임 외부 패키지로 유지한다.
  serverExternalPackages: ['embedded-postgres'],
  // 실험적 기능
  experimental: {
    // React 19 서버 컴포넌트 최적화
    ppr: false,
  },
  // 헤더 설정
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: 'http://localhost:3000' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,DELETE,PATCH,OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type' },
        ],
      },
    ];
  },
};

export default nextConfig;
