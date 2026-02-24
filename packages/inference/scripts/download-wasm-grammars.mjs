#!/usr/bin/env node
/**
 * tree-sitter WASM grammar 파일 다운로드 스크립트
 *
 * web-tree-sitter에서 사용할 언어별 .wasm 파일을 다운로드한다.
 * 소스: https://github.com/nicolo-ribaudo/tree-sitter-wasm-prebuilt
 *
 * 사용법:
 *   node scripts/download-wasm-grammars.mjs
 *   pnpm download:wasm
 */
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(__dirname, '..', 'wasm');

/** GitHub releases 기반 WASM grammar URL */
const GRAMMAR_URLS = {
    'tree-sitter-java.wasm':
        'https://github.com/nicolo-ribaudo/tree-sitter-wasm-prebuilt/releases/latest/download/tree-sitter-java.wasm',
    'tree-sitter-kotlin.wasm':
        'https://github.com/nicolo-ribaudo/tree-sitter-wasm-prebuilt/releases/latest/download/tree-sitter-kotlin.wasm',
    'tree-sitter-typescript.wasm':
        'https://github.com/nicolo-ribaudo/tree-sitter-wasm-prebuilt/releases/latest/download/tree-sitter-typescript.wasm',
    'tree-sitter-python.wasm':
        'https://github.com/nicolo-ribaudo/tree-sitter-wasm-prebuilt/releases/latest/download/tree-sitter-python.wasm',
};

async function download(url, dest) {
    console.log(`  Downloading ${url}...`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(dest, buffer);
    console.log(`  ✓ Saved to ${dest} (${(buffer.length / 1024).toFixed(1)} KB)`);
}

async function main() {
    console.log('Downloading tree-sitter WASM grammars...\n');

    if (!existsSync(WASM_DIR)) {
        mkdirSync(WASM_DIR, { recursive: true });
    }

    for (const [filename, url] of Object.entries(GRAMMAR_URLS)) {
        const dest = join(WASM_DIR, filename);
        if (existsSync(dest)) {
            console.log(`  ⊘ ${filename} already exists, skipping.`);
            continue;
        }
        try {
            await download(url, dest);
        } catch (err) {
            console.error(`  ✗ Failed to download ${filename}: ${err.message}`);
        }
    }

    console.log('\nDone.');
}

main().catch(console.error);
