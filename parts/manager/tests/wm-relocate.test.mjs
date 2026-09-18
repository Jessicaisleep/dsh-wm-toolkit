/**
 * Offline test for the ported file-level relocation module.
 *
 * Proves, on a synthetic session tree, that a folder migration:
 *   · moves the session directory to the new projectKey layout,
 *   · rewrites ONLY the header frame, leaving every following frame
 *     byte-identical (the invariant DSH's boot check depends on),
 *   · keeps the header a single line (assertZstdHeaderFrame),
 *   · updates the projection cache's identity.cwd,
 *   · and reports nothing left behind at the old path.
 *
 * Framing here deliberately mirrors the real backend: frame 0 is an
 * independently compressed single header line with a checksum, followed by
 * separately compressed event frames.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { projectKey, readHeader, scanFrames, relocateSessions } from '../lib/wm-relocate.js';

const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });

let failures = 0;
const check = (name, condition, detail = '') => {
	if (!condition) failures += 1;
	console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${detail === '' ? '' : '  ' + detail}`);
};

const scratch = mkdtempSync(join(tmpdir(), 'wm-relocate-test-'));
const sessionsRoot = join(scratch, 'sessions');
const projcacheDir = join(scratch, 'projcache');
const oldCwd = 'D:\\old-place';
const newCwd = 'D:\\new-place';
const sessionId = 'session-test-0001';

const headerLine = JSON.stringify({ id: sessionId, version: 3, cwd: oldCwd, createdAt: 1, isSeeded: false, agentPreset: 'standard' }) + '\n';
const eventLines = [JSON.stringify({ seq: 1, type: 'user/message', data: { text: 'hello' } }) + '\n', JSON.stringify({ seq: 2, type: 'assistant/message', data: { text: 'hi' } }) + '\n'];

const oldDir = join(sessionsRoot, projectKey(oldCwd), sessionId);
mkdirSync(oldDir, { recursive: true });
const original = Buffer.concat([frame(headerLine), frame(eventLines[0]), frame(eventLines[1])]);
writeFileSync(join(oldDir, 'session.v3.jsonl.zstd'), original);

mkdirSync(projcacheDir, { recursive: true });
writeFileSync(join(projcacheDir, sessionId + '.json'), JSON.stringify({ record: { identity: { cwd: oldCwd }, rows: {} } }, null, 2));

console.log('wm-relocate 迁移模块测试');
console.log(`  projectKey("${oldCwd}") = ${projectKey(oldCwd)}`);

const result = relocateSessions({ sessionsRoot, projcacheDir, fromCwd: oldCwd, toCwd: newCwd });
check('迁移清单非空且无失败', result.moved.length === 1 && result.failed.length === 0, JSON.stringify(result));

const newFile = join(sessionsRoot, projectKey(newCwd), sessionId, 'session.v3.jsonl.zstd');
check('日志已落到新 projectKey 目录', existsSync(newFile), newFile);
check('旧目录已清空/移除', !existsSync(join(sessionsRoot, projectKey(oldCwd), sessionId)));

const buffer = readFileSync(newFile);
const scan = scanFrames(buffer);
check('帧数量不变（3 帧）', scan.frames.length === 3, `实际 ${scan.frames.length}`);
const headerText = zlib.zstdDecompressSync(buffer.subarray(scan.frames[0].start, scan.frames[0].end)).toString('utf8');
check('header 仍是单独一行', headerText.endsWith('\n') && headerText.indexOf('\n') === headerText.length - 1);
const parsedHeader = JSON.parse(headerText.trim());
check('header.cwd 已改写为目标路径', parsedHeader.cwd === newCwd, parsedHeader.cwd);
check('header 其余字段保持不变', parsedHeader.id === sessionId && parsedHeader.agentPreset === 'standard');

const originalScan = scanFrames(original);
let tailIdentical = true;
for (let i = 1; i < originalScan.frames.length; i += 1) {
	const before = original.subarray(originalScan.frames[i].start, originalScan.frames[i].end);
	const after = buffer.subarray(scan.frames[i].start, scan.frames[i].end);
	if (!before.equals(after)) tailIdentical = false;
}
check('事件帧逐字节未改动', tailIdentical);

const cache = JSON.parse(readFileSync(join(projcacheDir, sessionId + '.json'), 'utf8'));
check('投影缓存 identity.cwd 已同步', cache.record.identity.cwd === newCwd, cache.record.identity.cwd);
check('readHeader 复读一致', readHeader(buffer).cwd === newCwd);

rmSync(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\n全部通过 ✔' : `\n有 ${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
