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
import { copyFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(__dirname, '..', 'wasm');
const require = createRequire(import.meta.url);

/** tree-sitter 공식 playground 레포에서 WASM grammar 다운로드 */
const BASE_URL = 'https://raw.githubusercontent.com/tree-sitter/tree-sitter.github.io/master';
const GRAMMAR_URLS = {
    'tree-sitter-java.wasm': `${BASE_URL}/tree-sitter-java.wasm`,
    'tree-sitter-kotlin.wasm': `${BASE_URL}/tree-sitter-kotlin.wasm`,
    'tree-sitter-typescript.wasm': `${BASE_URL}/tree-sitter-typescript.wasm`,
    'tree-sitter-python.wasm': `${BASE_URL}/tree-sitter-python.wasm`,
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

function ensureRuntimeWasm() {
    const dest = join(WASM_DIR, 'tree-sitter.wasm');
    if (existsSync(dest)) {
        console.log('  ⊘ tree-sitter.wasm already exists, skipping.');
        return true;
    }

    try {
        const src = require.resolve('web-tree-sitter/tree-sitter.wasm');
        copyFileSync(src, dest);
        console.log(`  ✓ Copied runtime wasm from ${src}`);
        return true;
    } catch (err) {
        console.error(`  ✗ Failed to copy runtime wasm: ${err.message}`);
        return false;
    }
}

function assertRequiredWasmFiles() {
    const required = ['tree-sitter.wasm', ...Object.keys(GRAMMAR_URLS)];
    const missing = required.filter((filename) => !existsSync(join(WASM_DIR, filename)));
    if (missing.length > 0) {
        throw new Error(`Required WASM assets are missing: ${missing.join(', ')}`);
    }
}

async function main() {
    console.log('Downloading tree-sitter WASM grammars...\n');

    if (!existsSync(WASM_DIR)) {
        mkdirSync(WASM_DIR, { recursive: true });
    }

    const runtimeReady = ensureRuntimeWasm();
    if (!runtimeReady) {
        console.warn('  ! runtime wasm copy failed; will continue and validate required assets.');
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

    assertRequiredWasmFiles();
    console.log('\nDone.');
}

main().catch(console.error);
