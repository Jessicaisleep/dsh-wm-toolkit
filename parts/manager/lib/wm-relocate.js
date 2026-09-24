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

/**
 * Reconcile one session's projection-cache identity with its stored header.
 *
 * 为什么需要：缓存行的 `record.identity` 是它与日志的绑定凭据。identity 一旦与当前
 * header 不匹配，`sessionProjectionCache.recordFor()` 就返回 undefined，冷列表路径会退化成
 * `basename(cwd)`，把工作区名（例如 "DSH"）当成会话标题显示出来。工作区搬家/改名之后
 * 就会出现这个症状（`patchProjcache` 只覆盖迁移当场，历史遗留要靠这里兜）。
 *
 * 为什么**不**调 `coldSnapshot`：它的真实签名是
 * `coldSnapshot(meta, inheritedEventCount, events)`——要求调用方提供**完整日志**，
 * 插件在启动时对每个会话解压 MB 级 zstd 工件并不划算。而这段 sweep 的目的只是让
 * identity 不过时，**修正 identity 就足以消除症状**。
 *
 * 只修能确定修正的四个字段；`inheritedEventCount` **原样保留**——工件 header 里没有它，
 * 缓存行里的值才是唯一来源（它由 seed 长度决定，改 cwd 不影响它）。
 *
 * @param {{ projcacheDir: string, header: object }} options
 * @returns {boolean} 是否真的改写了缓存行。
 */
export function reconcileProjcacheIdentity(options) {
	const { projcacheDir, header } = options;
	if (typeof projcacheDir !== 'string' || projcacheDir === '') return false;
	if (header === null || typeof header !== 'object') return false;
	if (typeof header.id !== 'string' || header.id === '') return false;
	const file = join(projcacheDir, header.id + '.json');
	if (!existsSync(file)) return false; // 没有缓存行 → 无需对账（首次冷读会创建）
	let parsed;
	try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
	const identity = parsed?.record?.identity;
	if (identity === null || typeof identity !== 'object') return false;
	let changed = false;
	if (typeof header.version === 'number' && identity.formatVersion !== header.version) {
		identity.formatVersion = header.version;
		changed = true;
	}
	if (typeof header.createdAt === 'number' && identity.createdAt !== header.createdAt) {
		identity.createdAt = header.createdAt;
		changed = true;
	}
	if (typeof header.cwd === 'string' && identity.cwd !== header.cwd) {
		identity.cwd = header.cwd;
		changed = true;
	}
	if (typeof header.isSeeded === 'boolean' && identity.isSeeded !== header.isSeeded) {
		identity.isSeeded = header.isSeeded;
		changed = true;
	}
	if (!changed) return false;
	writeAtomic(file, JSON.stringify(parsed, null, 2) + '\n');
	return true;
}

/**
 * 按磁盘工件对账某个会话的投影缓存 identity（自己定位工件、读 header）。
 *
 * 移动/迁移之后调用。`patchProjcache` 只覆盖"当场改 cwd"这一种情形，这里兜住其余不一致
 * （identity 的 createdAt / formatVersion / isSeeded 与工件对不上）。
 *
 * @param {{ sessionsRoot: string, projcacheDir: string, sessionId: string }} options
 * @returns {boolean} 是否改写了缓存行。
 */
export function reconcileProjcacheForSession(options) {
	const { sessionsRoot, projcacheDir, sessionId } = options;
	if (typeof sessionsRoot !== 'string' || typeof projcacheDir !== 'string') return false;
	if (typeof sessionId !== 'string' || sessionId === '') return false;
	const entry = listSessions(sessionsRoot).find((item) => item.sessionId === sessionId);
	if (entry === undefined) return false;
	let header;
	try {
		const { line } = readHeader(readFileSync(join(entry.dir, LOG_NAME)));
		header = JSON.parse(line);
	} catch {
		return false;
	}
	return reconcileProjcacheIdentity({ projcacheDir, header });
}

/**
 * Purge projection-cache rows whose session artifact is gone from disk.
 *
 * 为什么必须清：会话列表里的**冷行**就是 `<projcacheDir>/<id>.json`。删会话时如果只删了
 * 工件目录、漏了缓存行，界面上就会留下一行永远打不开（`session/not-found`，因为工件没了）、
 * 归档不了、也删不掉的**幽灵行**。
 *
 * 判据刻意只用**纯磁盘扫描**（{@link listSessions}），不依赖任何持久化索引——索引本身可能
 * 就带着已经删掉的 id。缓存行自带 `record.identity.cwd` 时再按它复算一次位置，磁盘上确实在
 * 就跳过，避免因为目录布局差异误删真实会话。
 *
 * @param {{ sessionsRoot: string, projcacheDir: string }} options
 * @returns {{ purged: string[] }} 被清掉缓存行的会话 id。
 */
export function purgeOrphanProjcache(options) {
	const { sessionsRoot, projcacheDir } = options;
	const purged = [];
	if (typeof sessionsRoot !== 'string' || typeof projcacheDir !== 'string') return { purged };
	if (!existsSync(projcacheDir)) return { purged };
	const onDisk = new Set(listSessions(sessionsRoot).map((item) => item.sessionId));
	let names;
	try { names = readdirSync(projcacheDir); } catch { return { purged }; }
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		const sessionId = name.slice(0, -'.json'.length);
		if (sessionId === '' || onDisk.has(sessionId)) continue;
		const file = join(projcacheDir, name);
		try {
			let cwd;
			try { cwd = JSON.parse(readFileSync(file, 'utf8'))?.record?.identity?.cwd; } catch { cwd = undefined; }
			if (typeof cwd === 'string' && cwd !== '') {
				// 双保险：按缓存行自己的 cwd 复算位置，磁盘上在就别删。
				if (existsSync(join(sessionsRoot, projectKey(cwd), sessionId))) continue;
			}
			rmSync(file, { force: true });
			purged.push(sessionId);
		} catch { /* 单行失败不影响其余 */ }
	}
	return { purged };
}
