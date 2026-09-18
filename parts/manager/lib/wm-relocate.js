/**
 * wm-relocate — file-level session relocation (wm fork addition).
 *
 * Verbatim port of the relocation core that was validated in practice before
 * this fork existed: it repairs the third of the three bindings a folder move
 * breaks, namely the physical log location
 *   <sessions root>/<projectKey(cwd)>/<session id>/session.v3.jsonl.zstd
 * which DSH re-derives from the header's `cwd` on every boot
 * (`assertStoredIdentity`) — a mismatch makes the session unreadable.
 *
 * Guarantees carried over from the validated implementation:
 *   · only frame 0 (the independent header frame) is re-compressed; every
 *     other frame is copied byte-for-byte, and the result is re-scanned and
 *     compared before it replaces anything;
 *   · directory move and header rewrite are one transaction per session — any
 *     failure restores both the bytes and the directory position;
 *   · the source project directory is removed only once it is empty.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const LOG_NAME = 'session.v3.jsonl.zstd';
const ZSTD_MAGIC = 0xfd2fb528;

/** Mirror of DSH's projectKey (JSONL persistence backend). */
export function projectKey(cwd) {
	if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cwd 不能为空');
	let readable = '';
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i += 1) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === '/' || ch === '\\' || ch === ':') {
			if (!separatorRun) readable += '-';
			separatorRun = true;
		} else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
			separatorRun = false;
		}
	}
	return '--' + ((readable.replace(/^-+/, '') || 'root').slice(0, 251)) + '--';
}

/** Structurally scan concatenated zstd frames; returns complete frames plus a torn tail start. */
export function scanFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`第 ${offset} 字节不是合法 zstd 帧魔数`);
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error('帧头保留位非 0');
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remaining) return { frames, tornStart: start };
		offset += remaining;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error('块类型为保留值');
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames };
}

const CWD_FIELD = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export function readHeader(buffer) {
	const scan = scanFrames(buffer);
	if (scan.frames.length === 0) throw new Error('没有扫描到完整帧');
	const line = zlib.zstdDecompressSync(buffer.subarray(scan.frames[0].start, scan.frames[0].end)).toString('utf8');
	if (!line.endsWith('\n') || line.indexOf('\n') !== line.length - 1) throw new Error('header 帧不是单独一行');
	const match = CWD_FIELD.exec(line);
	return { line, cwd: match === null ? undefined : JSON.parse('"' + match[1] + '"'), scan };
}

function writeAtomic(file, data) {
	const temp = file + '.dsh-wm-tmp';
	writeFileSync(temp, data);
	renameSync(temp, file);
}

/** Build the full log with the header cwd replaced; null when nothing needs changing. */
export function rewriteHeaderCwd(buffer, newCwd) {
	const { line, cwd, scan } = readHeader(buffer);
	if (cwd === undefined) return { next: null, cwd, reason: 'header 无 cwd' };
	if (cwd === newCwd) return { next: null, cwd, reason: 'cwd 已是目标值' };
	const match = CWD_FIELD.exec(line);
	const newLine = line.slice(0, match.index) + '"cwd":' + JSON.stringify(newCwd) + line.slice(match.index + match[0].length);
	if (JSON.parse(newLine).cwd !== newCwd) throw new Error('改写校验失败');
	const tailStart = scan.frames[1] !== undefined ? scan.frames[1].start : scan.tornStart !== undefined ? scan.tornStart : buffer.length;
	const next = Buffer.concat([
		zlib.zstdCompressSync(Buffer.from(newLine, 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }),
		buffer.subarray(tailStart),
	]);
	const rescan = scanFrames(next);
	if (rescan.frames.length !== scan.frames.length) throw new Error('重建后帧数不一致');
	for (let i = 1; i < scan.frames.length; i += 1) {
		const before = buffer.subarray(scan.frames[i].start, scan.frames[i].end);
		const after = next.subarray(rescan.frames[i].start, rescan.frames[i].end);
		if (!before.equals(after)) throw new Error(`第 ${i + 1} 帧被改动`);
	}
	return { next, cwd, reason: '' };
}

/** Every session directory under the sessions root. */
export function listSessions(sessionsRoot) {
	const out = [];
	if (!existsSync(sessionsRoot)) return out;
	for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		const projectDir = join(sessionsRoot, project.name);
		for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			out.push({ sessionId: entry.name, dir: join(projectDir, entry.name), projectDir });
		}
	}
	return out;
}

function patchProjcache(projcacheDir, sessionId, fromCwd, toCwd) {
	const file = join(projcacheDir, sessionId + '.json');
	if (!existsSync(file)) return false;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return false;
	}
	const identity = parsed?.record?.identity;
	if (identity === undefined || identity.cwd !== fromCwd) return false;
	identity.cwd = toCwd;
	writeAtomic(file, JSON.stringify(parsed, null, 2) + '\n');
	return true;
}

/**
 * Relocate every session whose stored cwd is `fromCwd` into `toCwd`'s project
 * directory, rewriting the header and the projection cache alongside.
 * @returns {{ moved: string[], skipped: {sessionId: string, reason: string}[], failed: {sessionId: string, reason: string}[] }}
 */
export function relocateSessions(options) {
	const { sessionsRoot, projcacheDir, fromCwd, toCwd, only } = options;
	const targetProjectDir = join(sessionsRoot, projectKey(toCwd));
	const moved = [];
	const skipped = [];
	const failed = [];
	for (const entry of listSessions(sessionsRoot)) {
		if (only !== undefined && entry.sessionId !== only) continue;
		const file = join(entry.dir, LOG_NAME);
		if (!existsSync(file)) continue;
		let header;
		try {
			header = readHeader(readFileSync(file));
		} catch (error) {
			failed.push({ sessionId: entry.sessionId, reason: '读取 header 失败：' + String(error?.message ?? error) });
			continue;
		}
		if (header.cwd !== fromCwd) {
			if (only !== undefined) skipped.push({ sessionId: entry.sessionId, reason: `cwd='${header.cwd}'，与来源不符` });
			continue;
		}
		const targetDir = join(targetProjectDir, entry.sessionId);
		if (existsSync(targetDir)) {
			failed.push({ sessionId: entry.sessionId, reason: '目标目录已存在：' + targetDir });
			continue;
		}
		try {
			mkdirSync(targetProjectDir, { recursive: true });
			const original = readFileSync(file);
			const patched = rewriteHeaderCwd(original, toCwd).next;
			if (patched === null) throw new Error('header 改写未产生新内容');
			renameSync(entry.dir, targetDir);
			try {
				writeAtomic(join(targetDir, LOG_NAME), patched);
				if (readHeader(readFileSync(join(targetDir, LOG_NAME))).cwd !== toCwd) throw new Error('落盘校验失败');
			} catch (error) {
				writeAtomic(join(targetDir, LOG_NAME), original);
				renameSync(targetDir, entry.dir);
				throw error;
			}
			patchProjcache(projcacheDir, entry.sessionId, fromCwd, toCwd);
			moved.push(entry.sessionId);
		} catch (error) {
			failed.push({ sessionId: entry.sessionId, reason: String(error?.message ?? error) });
		}
	}
	try {
		const sourceProjectDir = join(sessionsRoot, projectKey(fromCwd));
		if (existsSync(sourceProjectDir) && readdirSync(sourceProjectDir).length === 0) {
			try { rmdirSync(sourceProjectDir); } catch { /* ignore */ }
		}
	} catch { /* non-fatal */ }
	return { moved, skipped, failed };
}

/** Remove one session's log directory and projection cache. */
export function deleteSessionFiles(options) {
	const { sessionsRoot, projcacheDir, sessionId } = options;
	const removed = [];
	const entry = listSessions(sessionsRoot).find((item) => item.sessionId === sessionId);
	if (entry !== undefined) {
		try { rmSync(entry.dir, { recursive: true, force: true }); } catch { /* ignore */ }
		if (!existsSync(entry.dir)) removed.push(entry.dir);
		try {
			if (readdirSync(entry.projectDir).length === 0) rmdirSync(entry.projectDir);
		} catch { /* ignore */ }
	}
	const cache = join(projcacheDir, sessionId + '.json');
	if (existsSync(cache)) {
		try { rmSync(cache, { force: true }); } catch { /* ignore */ }
		if (!existsSync(cache)) removed.push(cache);
	}
	return { removed };
}
