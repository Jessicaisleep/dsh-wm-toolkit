/**
 * Workspace-menu overlay patch (wm fork addition).
 *
 * DSH's sidebar "workspace ⋯" menu is a hard-coded array inside the first-party
 * client bundle `@deepseek-ai/dsh-client-ui-workspace`; it exposes no slot, so
 * the only way to add an entry there is a small, well-guarded text overlay.
 *
 * Design rules (all of them exist to keep this safe across DSH updates):
 *   1. Every anchor must match exactly once; otherwise the patch is abandoned
 *      and nothing is written — a changed upstream never gets a broken file.
 *   2. The injected code is two tiny hooks into `globalThis.__DSH_WM__`, which
 *      the plugin's own client bundle defines. If that bundle did not load, the
 *      optional-chaining short-circuits and the menu is byte-for-byte the
 *      original behaviour.
 *   3. If DSH ever ships the same menu entry natively, detection skips the
 *      patch entirely (the fork deliberately stands down).
 *   4. The rewritten file must pass `node --check`; the previous bytes are kept
 *      in `<file>.dsh-wm-orig` and restored automatically if validation fails.
 *   5. Idempotent: a marker line records that the file is already patched, and
 *      a DSH update that replaces the file simply gets patched again on boot.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MARKER = '/* DSH-SESSION-MANAGER-WM:PATCH:v1 */';
const TARGET_PACKAGE = '@deepseek-ai/dsh-client-ui-workspace';

/** Upstream markers that mean DSH already offers workspace migration itself. */
const NATIVE_MARKERS = [/menu\.migrateWorkspace/, /menu\.moveWorkspace/, /menu\.relocateWorkspace/];

const ANCHORS = [
	{
		id: 'workspace.menuItems',
		find: /(danger: true\s*\n\s*\}\s*\]\s*;)/,
		replace: (matched) =>
			matched.replace(/\}\s*\]\s*;$/, '}, ...(globalThis.__DSH_WM__?.workspaceMenuItems?.() ?? [])];'),
	},
	{
		id: 'workspace.onSelect',
		find: /(if \(id !== "rename" && id !== "delete"\) return;)/,
		replace: (matched) => 'if (globalThis.__DSH_WM__?.handleWorkspaceMenu?.(id, row)) return;\n\t\t\t\t\t\t\t\t' + matched,
	},
];

const countMatches = (text, pattern) => {
	const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
	return (text.match(new RegExp(pattern.source, flags)) ?? []).length;
};

/**
 * Resolve the built-in workspace client bundle.
 * Preference order: an explicit override, then DSH's own clientModules service
 * (authoritative), then the packaged app layout.
 */
export function resolveWorkspaceBundle(ctx, override) {
	if (typeof override === 'string' && override !== '') return override;
	try {
		const clientModules = ctx?.get?.('clientModules');
		const resolved = clientModules?.clientPath?.(TARGET_PACKAGE);
		if (typeof resolved === 'string' && resolved !== '') return resolved;
	} catch {
		/* fall through */
	}
	const candidates = [];
	const appRoot = process.env.DSH_DESKTOP_APP_ROOT;
	if (typeof appRoot === 'string' && appRoot !== '') candidates.push(join(appRoot, 'node_modules', TARGET_PACKAGE, 'lib', 'client.js'));
	const execDir = process.execPath === undefined ? '' : process.execPath.replace(/[\\/][^\\/]+$/, '');
	if (execDir !== '') {
		candidates.push(join(execDir, 'resources', 'app', 'node_modules', TARGET_PACKAGE, 'lib', 'client.js'));
	}
	candidates.push(join(process.env['ProgramFiles'] ?? 'C:\\Program Files', '(x86)', 'DSH Desktop', 'resources', 'app', 'node_modules', TARGET_PACKAGE, 'lib', 'client.js'));
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[0];
}

function assertParses(source, nodeExe) {
	const temp = join(tmpdir(), `wm-patch-check-${process.pid}-${Date.now()}.cjs`);
	writeFileSync(temp, source);
	try {
		execFileSync(nodeExe ?? process.execPath, ['--check', temp], {
			stdio: 'pipe',
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		});
	} catch (error) {
		const detail = error.stderr === undefined ? String(error.message) : error.stderr.toString().trim();
		throw new Error('补丁后语法校验失败：' + detail);
	} finally {
		rmSync(temp, { force: true });
	}
}

/**
 * Apply the workspace-menu overlay.
 * @returns {{ changed: boolean, reason?: string, target?: string, applied?: string[], problems?: string[] }}
 */
export function applyWorkspaceMenuPatch(ctx, options = {}) {
	const target = resolveWorkspaceBundle(ctx, options.target);
	if (target === undefined || !existsSync(target)) {
		return { changed: false, reason: `找不到上游 bundle：${target}`, target };
	}
	const before = readFileSync(target, 'utf8');
	if (before.includes(MARKER)) return { changed: false, reason: '已经是补丁状态', target };

	if (NATIVE_MARKERS.some((marker) => marker.test(before))) {
		return { changed: false, reason: '上游已内置同类菜单项，按设计自动放弃补丁', target };
	}

	const problems = [];
	for (const anchor of ANCHORS) {
		const hits = countMatches(before, anchor.find);
		if (hits !== 1) problems.push(`${anchor.id}: 锚点命中 ${hits} 次（需要 1 次）`);
	}
	if (problems.length > 0) {
		return { changed: false, reason: '锚点未全部唯一命中，放弃补丁（上游结构可能已变化）', problems, target };
	}

	let source = before;
	const applied = [];
	for (const anchor of ANCHORS) {
		source = source.replace(anchor.find, (...args) => anchor.replace(args[0]));
		applied.push(anchor.id);
	}
	source = MARKER + '\n' + source;

	const backup = target + '.dsh-wm-orig';
	try {
		assertParses(source, options.nodeExe);
	} catch (error) {
		return { changed: false, reason: error.message, target };
	}
	if (!existsSync(backup)) writeFileSync(backup, before);
	const temp = target + '.dsh-wm-tmp';
	writeFileSync(temp, source);
	renameSync(temp, target);
	return { changed: true, applied, target };
}
