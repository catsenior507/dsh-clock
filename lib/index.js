import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
//#region src/host/store.ts
/**
* The durable alarm table.
*
* Alarms are cross-session, so the session log — the harness's own durability
* mechanism — is the wrong home for them: an alarm written into session A must
* still exist when session A is closed and only session B is being used. This
* store is therefore a plain JSON file under the plugin data directory, written
* atomically (temp file plus rename) so a kill mid-write leaves the previous
* table intact rather than a truncated one.
*
* @module dsh-clock/host/store
*/
/** Resolve the plugin data directory, defaulting to `$DSH_HOME/clock`. */
function resolveDataDir(configured) {
	if (configured !== void 0 && configured !== "") return configured;
	const home = process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? homedir();
	const base = home.endsWith(".dsh") ? home : join(home, ".dsh");
	return join(base, "clock");
}
/** Fill in defaults for a partial configuration. */
function resolveConfig(partial) {
	const input = partial ?? {};
	return {
		dataDir: resolveDataDir(input.dataDir),
		port: typeof input.port === "number" && input.port > 0 ? input.port : 4801,
		useSystemScheduler: input.useSystemScheduler !== false,
		exposeTool: input.exposeTool !== false,
		defaultTimeZone: input.defaultTimeZone ?? "",
		wakeMode: input.wakeMode === "steer" ? "steer" : "queue",
		retainFiredDays: typeof input.retainFiredDays === "number" && input.retainFiredDays >= 0 ? input.retainFiredDays : 7,
		driftToleranceSeconds: typeof input.driftToleranceSeconds === "number" && input.driftToleranceSeconds >= 0 ? input.driftToleranceSeconds : 60,
		wakeComputer: input.wakeComputer === true
	};
}
/** Fixed-width local stamp used to make ids sort by creation. */
function stamp(at) {
	const date = new Date(at);
	const pad = (value, width = 2) => String(value).padStart(width, "0");
	return String(date.getUTCFullYear()) + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate()) + pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds());
}
/**
* Allocate a collision-resistant alarm id.
* @param at - scheduled instant, used as the sortable prefix.
* @returns the id.
*/
function allocateAlarmId(at) {
	const random = Math.floor(Math.random() * 16777215).toString(36).padStart(4, "0");
	return "a-" + stamp(at) + "-" + random;
}
/** Why a create request was refused. */
var AlarmInputError = class extends Error {};
/**
* Validate and normalize one create request.
* @param input - the raw request.
* @returns a pending alarm ready to persist.
* @throws {AlarmInputError} when a required field is missing or malformed.
*/
function createAlarm(input, now) {
	if (!Number.isFinite(input.at)) throw new AlarmInputError("at must be a finite epoch-millisecond instant");
	if (typeof input.sessionId !== "string" || input.sessionId.trim() === "") throw new AlarmInputError("sessionId is required: an alarm must name the conversation to wake");
	const keyword = typeof input.keyword === "string" ? input.keyword.trim() : "";
	if (keyword === "") throw new AlarmInputError("keyword is required: it is what opens the wake message");
	return {
		id: allocateAlarmId(input.at),
		at: Math.round(input.at),
		timeZone: input.timeZone,
		keyword,
		note: input.note?.trim() === "" ? void 0 : input.note?.trim(),
		sessionId: input.sessionId.trim(),
		sessionTitle: input.sessionTitle,
		label: input.label?.trim() === "" ? void 0 : input.label?.trim(),
		origin: input.origin,
		createdAt: now,
		status: "pending"
	};
}
/**
* The in-memory table with its one durable file behind it.
*
* Every mutation persists before it returns, so a caller that has seen a
* successful add can rely on the alarm surviving a kill. The table is written
* whole rather than appended: it is small, and a whole-file rewrite is the
* cheapest way to keep it always-parseable.
*/
var AlarmStore = class {
	file;
	alarms = [];
	loaded = false;
	/** @param dataDir - directory holding `alarms.json`. */
	constructor(dataDir) {
		this.file = join(dataDir, "alarms.json");
	}
	/** Path of the backing file, for diagnostics. */
	get path() {
		return this.file;
	}
	/** Read the table, tolerating a missing or unparseable file by starting empty. */
	load() {
		if (this.loaded) return this.alarms;
		this.loaded = true;
		if (!existsSync(this.file)) return this.alarms;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8"));
			const rows = Array.isArray(parsed) ? parsed : parsed.alarms;
			if (Array.isArray(rows)) this.alarms = rows.filter((row) => {
				const candidate = row;
				return typeof candidate?.id === "string" && Number.isFinite(candidate?.at) && typeof candidate?.sessionId === "string";
			});
		} catch {
			this.alarms = [];
		}
		return this.alarms;
	}
	/** Every alarm, newest scheduled first. */
	all() {
		return this.load().slice().sort((left, right) => left.at - right.at);
	}
	/** Every alarm that can still fire, soonest first. */
	pending() {
		return this.all().filter((alarm) => alarm.status === "pending");
	}
	/** Look one alarm up by id. */
	get(id) {
		return this.load().find((alarm) => alarm.id === id);
	}
	/** Append one alarm and persist. */
	add(alarm) {
		this.load().push(alarm);
		this.persist();
		return alarm;
	}
	/** Apply a partial update and persist. */
	patch(id, patch) {
		const alarm = this.get(id);
		if (alarm === void 0) return void 0;
		Object.assign(alarm, patch);
		this.persist();
		return alarm;
	}
	/** Drop one alarm entirely. */
	remove(id) {
		const rows = this.load();
		const index = rows.findIndex((alarm) => alarm.id === id);
		if (index < 0) return false;
		rows.splice(index, 1);
		this.persist();
		return true;
	}
	/**
	* Forget settled alarms older than the retention window.
	* @param now - current instant.
	* @param retainFiredDays - how long a settled alarm stays visible.
	* @returns how many rows were dropped.
	*/
	prune(now, retainFiredDays) {
		const rows = this.load();
		const cutoff = now - retainFiredDays * 864e5;
		const kept = rows.filter((alarm) => alarm.status === "pending" || (alarm.firedAt ?? alarm.at) >= cutoff);
		const dropped = rows.length - kept.length;
		if (dropped > 0) {
			this.alarms = kept;
			this.persist();
		}
		return dropped;
	}
	/** Replace the whole table, used by tests and by a full re-read. */
	replace(rows) {
		this.alarms = rows;
		this.loaded = true;
		this.persist();
	}
	/** Write the table atomically. */
	persist() {
		const directory = dirname(this.file);
		mkdirSync(directory, { recursive: true });
		const temporary = this.file + ".tmp";
		writeFileSync(temporary, JSON.stringify({
			version: 1,
			alarms: this.alarms
		}, null, 2), "utf8");
		renameSync(temporary, this.file);
	}
	/** Remove the backing file entirely, used by tests. */
	destroy() {
		for (const target of [this.file, this.file + ".tmp"]) if (existsSync(target)) try {
			unlinkSync(target);
		} catch {}
		this.alarms = [];
		this.loaded = false;
	}
};
//#endregion
//#region src/host/time.ts
/**
* Zone-aware clock arithmetic.
*
* Every instant this plugin stores is epoch milliseconds, and every zone is an
* IANA name. Nothing is stored as a local wall-clock string, because a machine
* that changes zone between scheduling and firing must still deliver at the
* instant the user meant.
*
* @module dsh-clock/host/time
*/
/** The process time zone, used when configuration names none. */
function processTimeZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}
/**
* Validate an IANA zone by asking the platform to format with it.
* @param timeZone - candidate zone name.
* @returns whether the platform accepts it.
*/
function isValidTimeZone(timeZone) {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}
/** Offset of `timeZone` at `ms`, as `+08:00` / `-05:30` / `+00:00`. */
function zoneOffset(ms, timeZone) {
	try {
		const offset = (new Intl.DateTimeFormat("en-US", {
			timeZone,
			timeZoneName: "longOffset"
		}).formatToParts(new Date(ms)).find((part) => part.type === "timeZoneName")?.value ?? "GMT").replace("GMT", "");
		return offset === "" ? "+00:00" : offset;
	} catch {
		return "+00:00";
	}
}
/** `2026-09-11 09:30:00` in `timeZone`. */
function formatInZone(ms, timeZone) {
	try {
		return new Intl.DateTimeFormat("sv-SE", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false
		}).format(new Date(ms));
	} catch {
		return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
	}
}
/** `2026-09-11T09:30:00+08:00` — an RFC 3339 shape the model reads unambiguously. */
function isoInZone(ms, timeZone) {
	return formatInZone(ms, timeZone).replace(" ", "T") + zoneOffset(ms, timeZone);
}
/**
* Compact signed duration: `+4s`, `+2h13m`, `-90s`.
* @param deltaMs - signed difference.
* @returns the compact form.
*/
function durationText(deltaMs) {
	const sign = deltaMs < 0 ? "-" : "+";
	let rest = Math.abs(Math.round(deltaMs / 1e3));
	const days = Math.floor(rest / 86400);
	rest -= days * 86400;
	const hours = Math.floor(rest / 3600);
	rest -= hours * 3600;
	const minutes = Math.floor(rest / 60);
	const seconds = rest - minutes * 60;
	const parts = [];
	if (days > 0) parts.push(days + "d");
	if (hours > 0) parts.push(hours + "h");
	if (minutes > 0) parts.push(minutes + "m");
	if (seconds > 0 || parts.length === 0) parts.push(seconds + "s");
	return sign + parts.join("");
}
/**
* Classify delivery drift.
* @param driftMs - actual minus scheduled, signed.
* @param toleranceSeconds - how much lateness still counts as on time.
* @returns the verdict.
*/
function driftVerdict(driftMs, toleranceSeconds) {
	const tolerance = toleranceSeconds * 1e3;
	if (driftMs > tolerance) return "overdue";
	if (driftMs < -tolerance) return "early";
	return "on-time";
}
/** Smallest delay Node timers represent without clamping to 1ms. */
const MAX_TIMER_DELAY_MS = 2147483647;
//#endregion
//#region src/host/scheduler.ts
/** One re-armable timer plus the OS mirror, kept in step with the alarm table. */
var ClockScheduler = class {
	timer = null;
	armed = null;
	draining = false;
	disposed = false;
	/** The service that owns the alarm table and the delivery path. */
	host;
	/** @param host - the service that owns the alarm table and the delivery path. */
	constructor(host) {
		this.host = host;
	}
	/** The instant the in-process timer is currently armed for. */
	get armedFor() {
		return this.armed;
	}
	/** Arm the first timer. Call once the alarm table is readable. */
	start() {
		this.resync();
	}
	/** Re-derive both layers from the current alarm table. */
	async resync() {
		if (this.disposed) return;
		this.clearTimer();
		const earliest = this.host.earliestPending();
		if (earliest === null) {
			await this.host.syncSystemTask(null);
			return;
		}
		const error = await this.host.syncSystemTask(earliest);
		if (error !== null) this.host.log?.("system scheduler unavailable: " + error);
		if (this.disposed) return;
		this.arm(earliest);
	}
	/** Cancel any armed timer. */
	clearTimer() {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.armed = null;
	}
	/** Arm one bounded segment aimed at `at`. */
	arm(at) {
		const delay = Math.max(0, at - this.host.now());
		const bounded = Math.min(delay, MAX_TIMER_DELAY_MS);
		this.armed = at;
		this.timer = setTimeout(() => {
			this.onTimer();
		}, bounded);
		this.timer.unref?.();
	}
	/** Wake, fire what is due, and re-derive. */
	async onTimer() {
		this.timer = null;
		this.armed = null;
		if (this.disposed) return;
		if (!this.draining) {
			this.draining = true;
			try {
				await this.host.fireDue("timer");
			} catch (error) {
				this.host.log?.("timer fire failed: " + (error instanceof Error ? error.message : String(error)));
			} finally {
				this.draining = false;
			}
		}
		await this.resync();
	}
	/** Stop firing and release both layers. */
	dispose() {
		this.disposed = true;
		this.clearTimer();
	}
};
//#endregion
//#region src/host/fire.ts
/** How long a single delivery may take before it is abandoned. */
const WAKE_TIMEOUT_MS = 12e4;
/** Human wording for each trigger layer. */
const TRIGGER_LABEL = {
	timer: "in-process timer",
	"system-scheduler": "OS scheduler (Windows Task Scheduler)",
	"overdue-replay": "catch-up replay at host start",
	manual: "manual fire from the panel"
};
/**
* Render the message a woken conversation receives.
*
* Framework wording is English so the plugin reads the same for every user;
* the keyword and the note are interpolated verbatim, so they stay in whatever
* language their author wrote.
* @param alarm - the alarm being delivered.
* @param now - the instant delivery is happening.
* @param config - resolved configuration supplying the drift tolerance.
* @param trigger - which layer fired.
* @returns the text plus the drift it reported.
*/
function renderWakeText(alarm, now, config, trigger) {
	const driftMs = now - alarm.at;
	const verdict = driftVerdict(driftMs, config.driftToleranceSeconds);
	const lines = [];
	lines.push("⏰ dsh-clock wake — keyword: " + alarm.keyword);
	lines.push("");
	lines.push("scheduled  " + isoInZone(alarm.at, alarm.timeZone) + "  [" + alarm.timeZone + "]");
	lines.push("now        " + isoInZone(now, alarm.timeZone) + "  [" + alarm.timeZone + "]");
	lines.push("drift      " + durationText(driftMs) + "  " + verdict.toUpperCase());
	lines.push("now-epoch  " + String(now));
	lines.push("trigger    " + (TRIGGER_LABEL[trigger] ?? trigger));
	if (alarm.label !== void 0) lines.push("label      " + alarm.label);
	lines.push("");
	if (verdict === "overdue") lines.push("warning    OVERDUE by " + durationText(driftMs) + ": the host was not running at the scheduled instant and this is a catch-up delivery. Re-check anything time-sensitive before continuing.");
	else if (verdict === "early") lines.push("warning    EARLY by " + durationText(driftMs) + ": the system clock moved backwards since this alarm was set.");
	lines.push("note       This message was delivered by a timer, not typed by the user. Treat \"" + alarm.keyword + "\" as the signal to resume whatever was planned for this instant.");
	if (alarm.note !== void 0) lines.push("detail     " + alarm.note);
	return {
		text: lines.join("\n"),
		driftMs,
		verdict
	};
}
/**
* Deliver one alarm into its target conversation.
*
* The alarm is *not* marked fired here — the caller owns that transition, and
* marks it before calling, so a delivery that hangs cannot be re-entered by a
* second trigger layer.
* @param controller - the host session controller.
* @param alarm - the alarm to deliver.
* @param now - the instant of delivery.
* @param config - resolved configuration.
* @param trigger - which layer fired.
* @returns the delivered text, or the failure reason.
*/
async function deliverWake(controller, alarm, now, config, trigger) {
	const rendered = renderWakeText(alarm, now, config, trigger);
	const abort = new AbortController();
	const timeout = setTimeout(() => abort.abort(), WAKE_TIMEOUT_MS);
	try {
		await controller.prompt({
			requestId: "clock-" + alarm.id,
			sessionId: alarm.sessionId,
			mode: config.wakeMode,
			content: [{
				type: "text",
				text: rendered.text
			}],
			clientTimeZone: alarm.timeZone
		}, abort.signal);
		return {
			ok: true,
			text: rendered.text,
			driftMs: rendered.driftMs,
			verdict: rendered.verdict
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	} finally {
		clearTimeout(timeout);
	}
}
//#endregion
//#region src/host/system-scheduler.ts
/**
* The OS-level half of the scheduling: one Windows scheduled task that mirrors
* the earliest pending alarm.
*
* Why this exists at all, stated honestly, because it is the part of the design
* most likely to be over-claimed:
*
* - The **in-process timer** is the primary path and covers the ordinary case
*   (host running, machine awake) with one `setTimeout` and no polling.
* - A **catch-up replay at host start** covers the host not running.
* - What the OS task adds beyond those two is real but narrow: the platform
*   knows about machine sleep and missed schedules, so `StartWhenAvailable`
*   lets Windows run the task as soon as the machine is actually available
*   again, and it is the only layer that can be told to wake the machine. It is
*   also a redundant trigger if the host process itself is suspended.
*
* The task therefore does not *own* the alarm; it only pings the plugin's own
* endpoint, which fires due alarms idempotently. A missing, failed, or stale
* task degrades to the other two layers rather than losing the wake.
*
* Registration goes through PowerShell's ScheduledTasks module rather than
* `schtasks.exe` because only the module exposes `StartWhenAvailable`. The
* script is passed with `-EncodedCommand` (base64 UTF-16LE) so no quoting or
* escaping layer sits between this file and the shell.
*
* @module dsh-clock/host/system-scheduler
*/
/** Name of the single task this plugin owns; it is replaced, never accumulated. */
const SYSTEM_TASK_NAME = "dsh-clock-wake";
/** How long the registration PowerShell may take. */
const REGISTER_TIMEOUT_MS = 45e3;
/** Whether this platform has the scheduler this module drives. */
function systemSchedulerSupported() {
	return process.platform === "win32";
}
/** Encode a script for `powershell -EncodedCommand`. */
function encodePowerShell(script) {
	return Buffer.from(script, "utf16le").toString("base64");
}
/** Quote a value as a single-quoted PowerShell literal. */
function psQuote(value) {
	return "'" + value.replace(/'/g, "''") + "'";
}
/** `2026-09-11T09:30:00` in the machine's own zone — what `-At` expects. */
function localIso(ms) {
	const date = new Date(ms);
	const pad = (value) => String(value).padStart(2, "0");
	return String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}
/** Locate curl.exe, which Windows 10 1803 and later ship. */
function curlPath() {
	const candidates = [process.env.SystemRoot === void 0 ? "" : process.env.SystemRoot + "\\System32\\curl.exe", "C:\\Windows\\System32\\curl.exe"].filter((candidate) => candidate !== "");
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
	return null;
}
/** The ping the task performs when it fires. */
function tickUrl(port) {
	return "http://127.0.0.1:" + String(port) + "/api/clock/tick";
}
/** Build the action the task runs: a curl one-liner, or encoded PowerShell as a fallback. */
function buildAction(port) {
	const curl = curlPath();
	if (curl !== null) return {
		execute: curl,
		argument: "-s -S -o NUL -X POST --max-time 30 " + tickUrl(port)
	};
	return {
		execute: "powershell.exe",
		argument: "-NoProfile -NonInteractive -EncodedCommand " + encodePowerShell("try { Invoke-RestMethod -Method POST -Uri " + psQuote(tickUrl(port)) + " -TimeoutSec 30 | Out-Null } catch { }")
	};
}
/** The registration script for one alarm instant. */
function buildRegisterScript(at, port, wakeComputer) {
	const action = buildAction(port);
	return [
		"$ErrorActionPreference = " + psQuote("Stop"),
		"$action = New-ScheduledTaskAction -Execute " + psQuote(action.execute) + " -Argument " + psQuote(action.argument),
		"$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]" + psQuote(localIso(at)) + ")",
		"$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries" + (wakeComputer ? " -WakeToRun" : "") + " -ExecutionTimeLimit (New-TimeSpan -Minutes 5)",
		"$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited",
		"Register-ScheduledTask -TaskName " + psQuote(SYSTEM_TASK_NAME) + " -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null",
		"Write-Output 'dsh-clock: task registered'"
	].join("; ");
}
/** The removal script. */
function buildClearScript() {
	return [
		"$ErrorActionPreference = " + psQuote("SilentlyContinue"),
		"$existing = Get-ScheduledTask -TaskName " + psQuote(SYSTEM_TASK_NAME) + " -ErrorAction SilentlyContinue",
		"if ($existing) { Unregister-ScheduledTask -TaskName " + psQuote(SYSTEM_TASK_NAME) + " -Confirm:$false }",
		"Write-Output 'dsh-clock: task cleared'"
	].join("; ");
}
/** Run one PowerShell script, returning whether it succeeded and why not. */
function runPowerShell(script) {
	const result = spawnSync("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-EncodedCommand",
		encodePowerShell(script)
	], {
		encoding: "utf8",
		timeout: REGISTER_TIMEOUT_MS,
		windowsHide: true
	});
	if (result.error !== void 0 && result.error !== null) return {
		ok: false,
		detail: String(result.error.message ?? result.error)
	};
	if (result.status !== 0) {
		const stderr = (result.stderr ?? "").trim();
		const stdout = (result.stdout ?? "").trim();
		return {
			ok: false,
			detail: (stderr || stdout || "exit " + String(result.status)).slice(0, 400)
		};
	}
	return {
		ok: true,
		detail: (result.stdout ?? "").trim()
	};
}
/**
* Point the OS task at `at`, or remove it when there is nothing to arm.
* @param at - the earliest pending instant, or null to clear.
* @param port - the plugin's HTTP port.
* @param wakeComputer - whether the task may wake the machine from sleep.
* @returns null on success, otherwise the failure text.
*/
function syncSystemTask(at, port, wakeComputer) {
	if (!systemSchedulerSupported()) return null;
	const outcome = runPowerShell(at === null ? buildClearScript() : buildRegisterScript(at, port, wakeComputer));
	return outcome.ok ? null : outcome.detail;
}
//#endregion
//#region src/host/service.ts
/**
* Host-half orchestration: the alarm table, the three trigger layers, the wake
* path, and the reads the panel and the agent tool both use.
*
* The host half duck-types every harness service it touches. An external dsh
* plugin resolves only \`@deepseek-ai/cordis\` plus its own dependencies —
* \`dsh-session\`, \`dsh-tools\` and friends are not reachable from a linked
* package — so importing their types would silently inline a second copy of a
* runtime contract. The interfaces below restate exactly the surface this
* plugin uses, and every optional one degrades instead of failing.
*
* @module dsh-clock/host/service
*/
/** Normalize whatever a session hands back into shaped events. */
function normalizeEvents(raw) {
	const events = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue;
		const candidate = item;
		if (typeof candidate.type !== "string") continue;
		events.push({
			type: candidate.type,
			time: typeof candidate.time === "number" ? candidate.time : 0,
			data: candidate.data
		});
	}
	return events;
}
/**
* Find the first usable text inside an unknown payload.
*
* Deliberately schema-tolerant: this plugin must keep working across harness
* versions whose message-part shapes it cannot import, and a picker row with no
* preview is a far smaller failure than a thrown one.
* @param value - payload to walk.
* @param depth - recursion guard.
* @returns the text, or an empty string.
*/
function firstText(value, depth = 0) {
	if (depth > 4) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = firstText(item, depth + 1);
			if (found !== "") return found;
		}
		return "";
	}
	if (value !== null && typeof value === "object") {
		const record = value;
		if (typeof record.text === "string" && record.text.trim() !== "") return record.text;
		for (const key of [
			"content",
			"parts",
			"message",
			"data"
		]) {
			const found = firstText(record[key], depth + 1);
			if (found !== "") return found;
		}
	}
	return "";
}
/** Newest `session/title` in a log, or the first user message, or the id. */
function titleFromEvents(events, fallbackId) {
	let title = "";
	for (const event of events) {
		if (event.type !== "session/title") continue;
		const value = event.data?.title;
		if (typeof value === "string" && value.trim() !== "") title = value.trim();
	}
	if (title !== "") return title;
	const firstUser = events.find((event) => {
		if (event.type !== "user/message") return false;
		return (event.data?.source)?.kind === "user";
	});
	if (firstUser === void 0) return fallbackId;
	const text = firstText(firstUser.data).replace(/\s+/g, " ").trim();
	return text === "" ? fallbackId : text.slice(0, 48);
}
/**
* Whether a conversation belongs to subagent routing.
*
* This matters because such a session can never be woken: the session
* controller rejects an identity whose lifecycle belongs to subagent routing
* (its own `ApiSessionSubagentOwnership`), so offering one in the picker would
* be offering a target that is guaranteed to fail.
*
* Only `origin` is consulted. Subagent headers also carry a `delegationDepth`,
* but a depth field is exactly the kind of thing a future version might start
* writing on every session, and a check that silently emptied the picker would
* be far worse than one that occasionally shows an extra row.
* @param header - a live session header or a persistence snapshot header.
* @returns whether the session is a subagent's.
*/
function isSubagentSession(header) {
	return header?.origin === "subagent";
}
/**
* The plugin's host service.
*
* Three trigger layers converge on {@link fireDue}, and every one of them goes
* through {@link claimDue} first, which flips an alarm to `fired` *before* any
* delivery starts. That single ordering rule is what makes the layers safe to
* stack: whichever arrives first wins, and the others find nothing to claim.
*/
var ClockService = class {
	store;
	config;
	ctx;
	scheduler;
	injectedController;
	systemTaskArmedFor = null;
	lastSyncError;
	started = false;
	/** Cached titles for stored conversations, filled in the background. */
	storedTitles = /* @__PURE__ */ new Map();
	/**
	* What the background title read actually did.
	*
	* A cold conversation whose log cannot be read simply falls back to showing
	* its id, which is indistinguishable from "this conversation has no title".
	* These counters are what makes the difference visible from outside.
	*/
	titleIndex = {
		snapshots: 0,
		attempted: 0,
		titled: 0,
		failed: 0,
		rawEvents: -1,
		sampleEventKeys: "",
		lastError: ""
	};
	indexing = false;
	/** @param deps - context, optional configuration, optional test doubles. */
	constructor(deps) {
		this.ctx = deps.ctx;
		this.config = resolveConfig(deps.config);
		this.store = new AlarmStore(this.config.dataDir);
		this.scheduler = new ClockScheduler(this);
		this.injectedController = deps.controller;
		this.store.load();
	}
	/**
	* Append one line to the plugin's startup log.
	*
	* The harness logger's output does not reach the host's captured stdout, so a
	* plugin that activates only partly leaves no trace anywhere a maintainer can
	* read. This is that trace: which optional services resolved, and whether the
	* HTTP carrier and the agent tool actually mounted.
	* @param message - the line to record.
	*/
	note(message) {
		try {
			mkdirSync(this.config.dataDir, { recursive: true });
			appendFileSync(join(this.config.dataDir, "startup.log"), (/* @__PURE__ */ new Date()).toISOString() + " " + message + "\n", "utf8");
		} catch {}
	}
	/** Diagnostics sink that tolerates a context without a logger. */
	log(message) {
		try {
			this.ctx.logger?.warn("[clock] " + message);
		} catch {}
	}
	/** Current instant. */
	now() {
		return Date.now();
	}
	/** The display zone: configured, else the process zone. */
	get timeZone() {
		return this.config.defaultTimeZone === "" ? processTimeZone() : this.config.defaultTimeZone;
	}
	/**
	* Start all three layers.
	*
	* The overdue replay runs first and on purpose: an alarm whose instant passed
	* while the host was down is exactly the case the injected clock information
	* exists for, and delivering it at startup is the only way it is ever
	* delivered.
	*/
	start() {
		if (this.started) return;
		this.started = true;
		try {
			this.store.prune(this.now(), this.config.retainFiredDays);
		} catch (error) {
			this.log("prune failed: " + String(error));
		}
		this.replayAndArm();
		this.refreshStoredTitles();
	}
	/** Deliver anything already overdue, then arm both layers. */
	async replayAndArm() {
		try {
			const claimed = await this.fireDue("overdue-replay");
			if (claimed > 0) this.log("delivered " + String(claimed) + " overdue alarm(s) at startup");
		} catch (error) {
			this.log("overdue replay failed: " + String(error));
		}
		await this.scheduler.resync();
	}
	/** Instant of the soonest pending alarm. */
	earliestPending() {
		const pending = this.store.pending();
		return pending.length === 0 ? null : pending[0].at;
	}
	/** Mirror the soonest pending instant into the OS scheduler. */
	async syncSystemTask(at) {
		if (!this.config.useSystemScheduler || !systemSchedulerSupported()) {
			this.systemTaskArmedFor = null;
			return null;
		}
		const error = syncSystemTask(at, this.config.port, this.config.wakeComputer);
		this.lastSyncError = error ?? void 0;
		this.systemTaskArmedFor = error === null ? at : null;
		return error;
	}
	/** Snapshot of what the scheduler is currently doing, for the panel. */
	get schedulerState() {
		return {
			systemScheduler: this.config.useSystemScheduler && systemSchedulerSupported(),
			systemTaskArmedFor: this.systemTaskArmedFor,
			timerArmedFor: this.scheduler.armedFor,
			lastSyncError: this.lastSyncError
		};
	}
	/**
	* Claim everything due as of now, flipping each alarm out of `pending`.
	* @param trigger - which layer is claiming.
	* @returns the alarms this caller now owns.
	*/
	claimDue(trigger) {
		const now = this.now();
		const due = this.store.pending().filter((alarm) => alarm.at <= now);
		for (const alarm of due) this.store.patch(alarm.id, {
			status: "fired",
			firedAt: now,
			via: trigger
		});
		return due;
	}
	/** Deliver one already-claimed alarm and record the outcome. */
	async deliver(alarm, trigger) {
		const controller = this.controller();
		if (controller === void 0) {
			this.store.patch(alarm.id, { error: "sessionController is not available in this profile" });
			return;
		}
		const result = await deliverWake(controller, alarm, this.now(), this.config, trigger);
		if (result.ok) this.store.patch(alarm.id, {
			deliveredText: result.text,
			error: void 0
		});
		else {
			this.store.patch(alarm.id, { error: result.error });
			this.log("wake failed for " + alarm.id + ": " + result.error);
		}
	}
	/** Claim and deliver everything due, awaited. */
	async fireDue(trigger) {
		const due = this.claimDue(trigger);
		if (due.length === 0) return 0;
		await Promise.allSettled(due.map((alarm) => this.deliver(alarm, trigger)));
		await this.scheduler.resync();
		return due.length;
	}
	/**
	* Fire one named alarm now, regardless of its instant.
	* @param id - alarm identity.
	* @param trigger - how it was triggered.
	* @returns the alarm, or undefined when it does not exist.
	*/
	async fireOne(id, trigger) {
		if (this.store.get(id) === void 0) return void 0;
		this.store.patch(id, {
			status: "fired",
			firedAt: this.now(),
			via: trigger,
			error: void 0
		});
		await this.deliver(this.store.get(id), trigger);
		await this.scheduler.resync();
		return this.store.get(id);
	}
	/** Create one alarm and re-arm. */
	async create(input) {
		const alarm = createAlarm(input, this.now());
		this.store.add(alarm);
		await this.scheduler.resync();
		return alarm;
	}
	/** Replace the instant, keyword, note, or target of a pending alarm. */
	async update(id, patch) {
		const alarm = this.store.patch(id, patch);
		if (alarm !== void 0) await this.scheduler.resync();
		return alarm;
	}
	/** Cancel a pending alarm, keeping it visible as a cancelled row. */
	async cancel(id) {
		if (this.store.get(id) === void 0) return void 0;
		const updated = this.store.patch(id, { status: "cancelled" });
		await this.scheduler.resync();
		return updated;
	}
	/** Drop an alarm entirely. */
	async forget(id) {
		const removed = this.store.remove(id);
		if (removed) await this.scheduler.resync();
		return removed;
	}
	/** Resolve the session controller, preferring an injected test double. */
	controller() {
		if (this.injectedController !== void 0) return this.injectedController;
		const service = this.ctx.get?.("sessionController");
		return service === void 0 ? void 0 : service;
	}
	persistence() {
		return this.ctx.get?.("sessionPersistence");
	}
	/**
	* Live and stored conversations, newest first.
	*
	* The stored half is the point: an alarm exists to reach a conversation that
	* may be closed, and the live store only contains sessions somebody has
	* opened in this host generation.
	* @returns picker rows.
	*/
	async listSessions() {
		const rows = [];
		const known = /* @__PURE__ */ new Set();
		for (const session of this.ctx.sessions?.list() ?? []) {
			if (isSubagentSession(session.header)) continue;
			const events = session.snapshotEvents === void 0 ? [] : normalizeEvents(session.snapshotEvents());
			const last = events[events.length - 1];
			known.add(session.id);
			rows.push({
				id: session.id,
				title: titleFromEvents(events, session.id),
				cwd: session.header?.cwd,
				createdAt: session.header?.createdAt ?? 0,
				updatedAt: last === void 0 ? session.header?.createdAt ?? 0 : last.time,
				cold: false
			});
		}
		const persistence = this.persistence();
		if (persistence !== void 0) try {
			for (const snapshot of await persistence.list()) {
				if (isSubagentSession(snapshot.header)) continue;
				const id = snapshot.header?.id;
				if (typeof id !== "string" || id === "" || known.has(id)) continue;
				known.add(id);
				const createdAt = snapshot.header?.createdAt ?? 0;
				rows.push({
					id,
					title: this.storedTitles.get(id) ?? id,
					cwd: snapshot.header?.cwd,
					createdAt,
					updatedAt: createdAt,
					cold: true
				});
			}
		} catch {}
		if (rows.some((row) => row.cold && row.title === row.id)) this.refreshStoredTitles();
		return rows.sort((left, right) => right.updatedAt - left.updatedAt);
	}
	/**
	* Read stored conversation titles once, in the background.
	*
	* A persistence snapshot carries only a header, so a cold conversation has no
	* title until its log is opened. Opening every log on the request path would
	* make the picker slow and would hold read handles while the panel is open, so
	* this runs once after start, writes each title as it lands, and is purely
	* additive: rows are usable (by id) before it finishes.
	*/
	async refreshStoredTitles() {
		if (this.indexing) return;
		const persistence = this.persistence();
		if (persistence === void 0) {
			this.titleIndex.lastError = "sessionPersistence not resolvable yet";
			return;
		}
		this.indexing = true;
		try {
			const snapshots = await persistence.list();
			this.titleIndex.snapshots = snapshots.length;
			for (const snapshot of snapshots) {
				const id = snapshot.header?.id;
				if (typeof id !== "string" || id === "" || this.storedTitles.has(id)) continue;
				this.titleIndex.attempted += 1;
				let handle;
				try {
					handle = await persistence.open(id, "read");
					const raw = (await handle.read()).events ?? [];
					if (this.titleIndex.rawEvents < 0) {
						this.titleIndex.rawEvents = raw.length;
						const first = raw[0];
						this.titleIndex.sampleEventKeys = first === void 0 || first === null || typeof first !== "object" ? "(first entry is " + String(first) + ")" : Object.keys(first).join(",");
					}
					const title = titleFromEvents(normalizeEvents(raw), id);
					this.storedTitles.set(id, title);
					if (title !== id) this.titleIndex.titled += 1;
				} catch (error) {
					this.titleIndex.failed += 1;
					this.titleIndex.lastError = String(error).slice(0, 200);
					this.storedTitles.set(id, id);
				} finally {
					try {
						await handle?.close?.();
					} catch {}
				}
			}
		} catch {} finally {
			this.indexing = false;
		}
	}
	/** Everything the panel renders in one read. */
	async state() {
		return {
			now: this.now(),
			timeZone: this.timeZone,
			alarms: this.store.all(),
			sessions: await this.listSessions(),
			scheduler: this.schedulerState,
			titleIndex: { ...this.titleIndex },
			config: {
				port: this.config.port,
				dataDir: this.config.dataDir,
				defaultTimeZone: this.timeZone,
				wakeMode: this.config.wakeMode
			}
		};
	}
	/** Stop the scheduler and release the OS task. */
	async dispose() {
		this.scheduler.dispose();
		if (this.config.useSystemScheduler && systemSchedulerSupported()) await this.syncSystemTask(null);
	}
};
//#endregion
//#region src/host/api.ts
/**
* The plugin HTTP surface, shared by both carriers.
*
* Two transports mount the same handler table: the harness `webServer` service
* when the profile has one, and a private loopback server otherwise, because a
* headless profile has no web server at all and the OS-scheduler ping still has
* to reach a real endpoint.
*
* Every response is JSON shaped `{ ok: true, value }` or `{ ok: false, error }`,
* so the panel has exactly one failure shape to render.
*
* @module dsh-clock/host/api
*/
/** Path prefix used when the plugin rides the harness web server. */
const API_PREFIX = "/api/clock";
/** Read a request body as text, bounded so a malformed peer stays harmless. */
async function readBody(req, limit = 1048576) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > limit) throw new Error("request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse a JSON body, treating an empty body as an empty object. */
function parseJson(text) {
	if (text.trim() === "") return {};
	const parsed = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
	return parsed;
}
/** Read a required non-empty string field. */
function requiredString(body, field) {
	const value = body[field];
	if (typeof value !== "string" || value.trim() === "") throw new Error(field + " is required");
	return value.trim();
}
/** Read an optional trimmed string field. */
function optionalString(body, field) {
	const value = body[field];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/**
* Resolve the instant a request names.
*
* Two spellings are accepted because two callers exist: the agent tool states a
* delay ("in twenty minutes"), while the panel states an exact instant it drew
* on a calendar. Both land here as epoch milliseconds.
* @param body - the request body.
* @param now - current instant, the base for a relative request.
* @returns the resolved instant.
*/
function resolveRequestedAt(body, now) {
	const after = body.afterSeconds;
	if (typeof after === "number" && Number.isFinite(after)) return now + Math.round(after * 1e3);
	const at = body.at;
	if (typeof at === "number" && Number.isFinite(at)) return Math.round(at);
	if (typeof at === "string" && at.trim() !== "") {
		const parsed = Date.parse(at);
		if (Number.isNaN(parsed)) throw new Error("at is not a parseable date-time: " + at);
		return parsed;
	}
	throw new Error("either at (epoch ms or ISO string) or afterSeconds is required");
}
/** Wrap a value as a success response. */
function ok(value) {
	return {
		status: 200,
		body: {
			ok: true,
			value
		}
	};
}
/** Wrap a message as a failure response. */
function fail(status, error) {
	return {
		status,
		body: {
			ok: false,
			error
		}
	};
}
/**
* Resolve one request against the service.
* @param deps - the clock service.
* @param method - HTTP method.
* @param pathname - pathname, absolute or prefixed.
* @param _query - decoded query parameters.
* @param body - parsed JSON body.
* @returns the status and JSON body to send.
*/
async function handle(deps, method, pathname, _query, body) {
	const path = pathname.startsWith("/api/clock") ? pathname.slice(10) : pathname;
	const service = deps.service;
	try {
		if (method === "GET" && (path === "/state" || path === "/" || path === "")) return ok(await service.state());
		if (method === "GET" && path === "/now") {
			const now = service.now();
			return ok({
				now,
				timeZone: service.timeZone,
				iso: isoInZone(now, service.timeZone)
			});
		}
		if (method === "POST" && path === "/alarms") {
			const now = service.now();
			const requestedZone = optionalString(body, "timeZone");
			const timeZone = requestedZone !== void 0 && isValidTimeZone(requestedZone) ? requestedZone : service.timeZone;
			const sessionTitle = optionalString(body, "sessionTitle");
			return ok(await service.create({
				at: resolveRequestedAt(body, now),
				timeZone,
				keyword: requiredString(body, "keyword"),
				note: optionalString(body, "note"),
				sessionId: requiredString(body, "sessionId"),
				sessionTitle,
				label: optionalString(body, "label"),
				origin: body.origin === "agent" ? "agent" : "user"
			}));
		}
		if (method === "POST" && path === "/alarms/update") {
			const id = requiredString(body, "id");
			const patch = {};
			if (body.at !== void 0 || body.afterSeconds !== void 0) patch.at = resolveRequestedAt(body, service.now());
			if (typeof body.keyword === "string" && body.keyword.trim() !== "") patch.keyword = body.keyword.trim();
			if (typeof body.note === "string") patch.note = body.note.trim() === "" ? void 0 : body.note.trim();
			if (typeof body.label === "string") patch.label = body.label.trim() === "" ? void 0 : body.label.trim();
			if (typeof body.sessionId === "string" && body.sessionId.trim() !== "") patch.sessionId = body.sessionId.trim();
			if (typeof body.sessionTitle === "string") patch.sessionTitle = body.sessionTitle;
			if (typeof body.timeZone === "string" && isValidTimeZone(body.timeZone)) patch.timeZone = body.timeZone;
			const updated = await service.update(id, patch);
			return updated === void 0 ? fail(404, "no alarm with id " + id) : ok(updated);
		}
		if (method === "POST" && path === "/alarms/cancel") {
			const updated = await service.cancel(requiredString(body, "id"));
			return updated === void 0 ? fail(404, "no alarm with that id") : ok(updated);
		}
		if (method === "POST" && path === "/alarms/forget") return await service.forget(requiredString(body, "id")) ? ok({ removed: true }) : fail(404, "no alarm with that id");
		if (method === "POST" && path === "/alarms/fire") {
			const fired = await service.fireOne(requiredString(body, "id"), "manual");
			return fired === void 0 ? fail(404, "no alarm with that id") : ok(fired);
		}
		if (method === "POST" && path === "/client-log") {
			const message = typeof body.message === "string" ? body.message.slice(0, 400) : "";
			if (message !== "") service.note("client: " + message);
			return ok({ recorded: message !== "" });
		}
		if (method === "POST" && path === "/tick") {
			const claimed = service.claimDue("system-scheduler");
			if (claimed.length > 0) Promise.allSettled(claimed.map((alarm) => service.deliver(alarm, "system-scheduler"))).then(() => service.schedulerState);
			return ok({
				claimed: claimed.length,
				ids: claimed.map((alarm) => alarm.id)
			});
		}
		return fail(404, "no such endpoint: " + method + " " + path);
	} catch (error) {
		return fail(400, error instanceof Error ? error.message : String(error));
	}
}
/** Adapt the handler table to a Node request/response pair. */
/**
* CORS headers for a request that came from this machine.
*
* The panel is served by the harness web server on one port while this carrier
* listens on another, so every call the panel makes is cross-origin and the
* browser discards the response without these headers. That failure looks like
* a panel that renders but can never save anything, because it is silent in the
* page and never reaches this handler as an error.
*
* The allowed origin is ECHOED rather than set to a wildcard. Creating an alarm
* ends in a message injected into a conversation, so `*` would let any page the
* user happens to visit schedule a prompt injection against their own agent.
* Only loopback origins are accepted.
* @param origin - the request's Origin header, when present.
* @returns headers to merge into the response.
*/
function corsHeaders(origin) {
	if (origin === void 0) return {};
	try {
		const host = new URL(origin).hostname;
		if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return {};
		return {
			"access-control-allow-origin": origin,
			"access-control-allow-methods": "GET, POST, OPTIONS",
			"access-control-allow-headers": "content-type",
			"access-control-max-age": "600",
			vary: "Origin"
		};
	} catch {
		return {};
	}
}
async function nodeHandler(deps, req, res) {
	const cors = corsHeaders(req.headers.origin);
	if ((req.method ?? "GET").toUpperCase() === "OPTIONS") {
		res.writeHead(204, cors);
		res.end();
		return;
	}
	let response;
	try {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const method = (req.method ?? "GET").toUpperCase();
		let body = {};
		if (method === "POST" || method === "PATCH" || method === "PUT") body = parseJson(await readBody(req));
		response = await handle(deps, method, url.pathname, url.searchParams, body);
	} catch (error) {
		response = fail(400, error instanceof Error ? error.message : String(error));
	}
	const payload = JSON.stringify(response.body);
	res.writeHead(response.status, {
		...cors,
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store"
	});
	res.end(payload);
}
/**
* Mount the API on the harness web server.
* @param webServer - the webServer service.
* @param deps - the clock service.
* @returns the disposer removing the route.
*/
function registerWebRoute(webServer, deps) {
	return webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: (req, res) => nodeHandler(deps, req, res)
	});
}
/** Bind one private carrier on exactly one port. */
function listenOnce(deps, port) {
	const server = createServer((req, res) => {
		nodeHandler(deps, req, res);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve(server);
		});
	});
}
/**
* Start the private loopback server used when the harness web server is not
* reachable from this plugin's context.
*
* A restart is exactly when a fixed port is least reliable — the outgoing host
* may still hold the socket while the incoming one boots — so a short range is
* walked rather than failing the feature on the first `EADDRINUSE`.
* @param deps - the clock service.
* @returns the listening server.
* @throws when every port in the range is unavailable.
*/
async function startStandaloneServer(deps) {
	let lastError = /* @__PURE__ */ new Error("no port available");
	for (let offset = 0; offset < 8; offset += 1) try {
		return await listenOnce(deps, deps.service.config.port + offset);
	} catch (error) {
		lastError = error;
	}
	throw lastError;
}
//#endregion
//#region src/host/tool.ts
/** The model-facing tool name. */
const TOOL_NAME = "clock";
/** Parameter schema, written directly as JSON Schema. */
const PARAMETERS = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: {
			type: "string",
			enum: [
				"now",
				"set",
				"list",
				"cancel"
			],
			description: "now reads the current time. set creates a wake-up. list shows alarms. cancel removes pending ones."
		},
		sessionId: {
			type: "string",
			description: "Conversation to wake. Defaults to the calling conversation; set it to wake a different one."
		},
		afterSeconds: {
			type: "number",
			description: "Relative delay in seconds from now. Give this or at, not both."
		},
		at: {
			type: "string",
			description: "Absolute instant as an ISO-8601 string, e.g. 2026-09-11T09:30:00+08:00. Give this or afterSeconds."
		},
		timeZone: {
			type: "string",
			description: "IANA zone the instant should be displayed in, e.g. Asia/Shanghai. Defaults to the host zone."
		},
		keyword: {
			type: "string",
			description: "The word or short phrase that opens the wake message and identifies why the agent was woken."
		},
		note: {
			type: "string",
			description: "Longer instruction carried into the wake message, e.g. what to check when it arrives."
		},
		label: {
			type: "string",
			description: "Short label for the alarm itself, shown in the panel."
		},
		id: {
			type: "string",
			description: "Alarm id, for cancel."
		},
		all: {
			type: "boolean",
			description: "With cancel, cancel every pending alarm of the calling conversation."
		}
	},
	required: ["action"]
};
/**
* Render one alarm as a compact row.
*
* Optional fields are assigned only when present. A key holding `undefined` is
* still a key, and the output schema below is strict, so leaving one in place
* would fail validation at the registry rather than simply being omitted.
* @param alarm - the alarm to render.
* @param now - current instant, for the relative field.
* @returns the row.
*/
function toRow(alarm, now) {
	const row = {
		id: alarm.id,
		at: isoInZone(alarm.at, alarm.timeZone),
		in: durationText(alarm.at - now),
		keyword: alarm.keyword,
		sessionId: alarm.sessionId,
		status: alarm.status
	};
	if (alarm.label !== void 0) row.label = alarm.label;
	if (alarm.note !== void 0) row.note = alarm.note;
	if (alarm.error !== void 0) row.error = alarm.error;
	return row;
}
/**
* Output schema: the canonical value every call returns.
*
* The registry requires an output declaration — it refuses a tool with none,
* reporting `tool "<name>" must declare output`. This is that declaration for
* the clock tool, written as raw JSON Schema for the same reason the parameter
* schema is: this plugin cannot import the harness schema compiler.
*/
const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: { type: "string" },
		summary: { type: "string" },
		sessionId: { type: "string" },
		timeZone: { type: "string" },
		now: { type: "string" },
		alarms: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string" },
					at: { type: "string" },
					in: { type: "string" },
					keyword: { type: "string" },
					sessionId: { type: "string" },
					status: { type: "string" },
					label: { type: "string" },
					note: { type: "string" },
					error: { type: "string" }
				},
				required: [
					"id",
					"at",
					"in",
					"keyword",
					"sessionId",
					"status"
				]
			}
		},
		notes: {
			type: "array",
			items: { type: "string" }
		}
	},
	required: [
		"action",
		"summary",
		"sessionId",
		"timeZone",
		"now",
		"alarms",
		"notes"
	]
};
/**
* Build the tool definition bound to one service.
* @param service - the clock service.
* @returns the definition the registry accepts.
*/
function buildTool(service) {
	return {
		name: TOOL_NAME,
		description: "Schedule a wake-up: when a chosen instant passes, a message carrying a keyword is delivered into a conversation — by default this one, or another conversation by id. Use it to come back to work at a set time. A wake delivered late says so, including the scheduled time, the actual time, and the drift.",
		parameters: PARAMETERS,
		output: {
			schema: OUTPUT_SCHEMA,
			render(_args, value) {
				const lines = [value.summary];
				if (value.notes.length > 0) lines.push(...value.notes.map((note) => "· " + note));
				for (const row of value.alarms) lines.push(row.at + "  in " + row.in + "  [" + row.status + "]  " + row.keyword + "  -> " + row.sessionId);
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		execute: async (args, exec) => {
			const action = String(args.action ?? "");
			const callingSession = exec.agent?.session?.id ?? "";
			const now = service.now();
			const notes = [];
			if (action === "now") {
				const requested = typeof args.timeZone === "string" && isValidTimeZone(args.timeZone) ? args.timeZone : service.timeZone;
				return {
					action,
					summary: "Current time is " + isoInZone(now, requested) + " [" + requested + "].",
					sessionId: callingSession,
					timeZone: requested,
					now: isoInZone(now, requested),
					alarms: [],
					notes
				};
			}
			if (action === "set") {
				const target = typeof args.sessionId === "string" && args.sessionId.trim() !== "" ? args.sessionId.trim() : callingSession;
				if (target === "") throw new Error("no target conversation: pass sessionId explicitly");
				let at;
				if (typeof args.afterSeconds === "number" && Number.isFinite(args.afterSeconds)) at = now + Math.round(args.afterSeconds * 1e3);
				else if (typeof args.at === "string" && args.at.trim() !== "") {
					const parsed = Date.parse(args.at);
					if (Number.isNaN(parsed)) throw new Error("at must be a parseable ISO-8601 instant with an explicit offset, e.g. 2026-09-11T09:30:00+08:00");
					at = parsed;
				} else throw new Error("pass either afterSeconds or an explicit at instant");
				const requestedZone = typeof args.timeZone === "string" && isValidTimeZone(args.timeZone) ? args.timeZone : service.timeZone;
				const alarm = await service.create({
					at,
					timeZone: requestedZone,
					keyword: String(args.keyword ?? ""),
					note: typeof args.note === "string" ? args.note : void 0,
					label: typeof args.label === "string" ? args.label : void 0,
					sessionId: target,
					origin: "agent"
				});
				if (target !== callingSession) notes.push("This alarm wakes a different conversation (" + target + "); it will be resumed if it is closed.");
				return {
					action,
					summary: "Alarm " + alarm.id + " will wake " + target + " at " + isoInZone(at, requestedZone) + ".",
					sessionId: callingSession,
					timeZone: requestedZone,
					now: isoInZone(now, requestedZone),
					alarms: [toRow(alarm, now)],
					notes
				};
			}
			if (action === "list") {
				const rows = service.store.all().map((alarm) => toRow(alarm, now));
				return {
					action,
					summary: rows.length === 0 ? "No alarms." : String(rows.length) + " alarm(s).",
					sessionId: callingSession,
					timeZone: service.timeZone,
					now: isoInZone(now, service.timeZone),
					alarms: rows,
					notes
				};
			}
			if (action === "cancel") {
				if (args.all === true) {
					if (callingSession === "") throw new Error("cannot cancel all without a calling conversation");
					const mine = service.store.pending().filter((alarm) => alarm.sessionId === callingSession);
					for (const alarm of mine) await service.cancel(alarm.id);
					return {
						action,
						summary: "Cancelled " + String(mine.length) + " pending alarm(s) for this conversation.",
						sessionId: callingSession,
						timeZone: service.timeZone,
						now: isoInZone(now, service.timeZone),
						alarms: [],
						notes
					};
				}
				const id = typeof args.id === "string" ? args.id.trim() : "";
				if (id === "") throw new Error("pass id, or all: true");
				const cancelled = await service.cancel(id);
				if (cancelled === void 0) throw new Error("no alarm with id " + id);
				return {
					action,
					summary: "Cancelled alarm " + id + ".",
					sessionId: callingSession,
					timeZone: service.timeZone,
					now: isoInZone(now, service.timeZone),
					alarms: [toRow(cancelled, now)],
					notes
				};
			}
			throw new Error("unknown action: " + action);
		}
	};
}
/**
* Register the clock tool.
* @param tools - the tool registry.
* @param service - the clock service.
* @returns the disposer removing the tool.
*/
function registerTool(tools, service) {
	return tools.register(buildTool(service));
}
//#endregion
//#region src/host/skill.ts
/**
* The skill this plugin contributes to the agent's skill catalog.
*
* Why a skill and not just the tool: the tool is advertised by its one-line
* description, which is enough to know it exists and nowhere near enough to use
* it well. A conversation that has never seen this plugin has no idea that a
* target may be a closed conversation, that a closed target keeps its own id,
* or that an alarm set while the host is down is delivered late and says so.
* The skill is that knowledge, loaded on demand instead of carried in every
* request.
*
* @module dsh-clock/host/skill
*/
/** The kebab-case name the catalog advertises. */
const SKILL_NAME = "clock";
/** One line for routing decisions. */
const SKILL_DESCRIPTION = "Schedule a wake-up: at a chosen instant a message carrying a keyword is delivered into a chosen conversation, including one that is closed. Use for reminders, for returning to slow work, and for resuming another conversation later.";
/** Longer guidance shown alongside the description by discovery consumers. */
const SKILL_WHEN_TO_USE = "Use when something should happen at a set time rather than now: a reminder the user asked for, a slow job to check back on, or work that must resume in a different conversation.";
/** The markdown body the model reads when it loads the skill. */
const SKILL_BODY = "# clock — schedule a wake-up\n\n`clock` schedules a message to arrive in a conversation at a chosen instant. The message opens\nwith a keyword you choose, and it carries the scheduled time, the actual time, and the signed\ndrift, so the conversation that gets woken can tell \"on time\" from \"three hours late\".\n\n## When to use it\n\n- The user says \"remind me\", \"come back to this in an hour\", \"check the build at 17:00\".\n- You are starting something slow and know you should return to it.\n- Work should resume later in a **different** conversation, including one that is currently\n  closed. That is the case this exists for: the harness's own reminders are session-local and\n  cannot reach a conversation nobody has open.\n\nDo not use it as a notification channel. It delivers into a dsh conversation — not to a phone,\nnot by mail, not by push.\n\n## Actions\n\n| action | what it does |\n| --- | --- |\n| `now` | the current time, in a zone |\n| `set` | create a wake-up |\n| `list` | pending and recent alarms, with any delivery error |\n| `cancel` | cancel one by `id`, or `all: true` for every pending alarm of this conversation |\n\n## Setting one\n\nRelative delay, waking this conversation:\n\n    clock { action: \"set\", afterSeconds: 2700, keyword: \"check the build\",\n            note: \"the release job should be done by now\" }\n\nAbsolute instant, waking another conversation — including a closed one:\n\n    clock { action: \"set\", at: \"2026-09-11T09:30:00+08:00\", timeZone: \"Asia/Shanghai\",\n            keyword: \"standup\", sessionId: \"session-…\" }\n\n`sessionId` defaults to the calling conversation. A closed target is resumed before the message\nlands and **keeps its own id** — it is continued, not forked. Give `at` an explicit offset, or\npass `timeZone`, because an unqualified local time is a guess about which machine meant it.\n\n## What the woken conversation receives\n\n    ⏰ dsh-clock wake — keyword: check the build\n\n    scheduled  2026-09-11T09:30:00+08:00  [Asia/Shanghai]\n    now        2026-09-11T11:43:12+08:00  [Asia/Shanghai]\n    drift      +2h13m  OVERDUE\n    trigger    in-process timer\n\n    warning    OVERDUE by +2h13m: the host was not running at the scheduled instant …\n    note       This message was delivered by a timer, not typed by the user. …\n    detail     the release job should be done by now\n\n## Limits worth stating before you rely on one\n\n- **The host must be running.** Only the host can resume a conversation, so if dsh web is not up\n  at the scheduled instant the alarm is delivered as soon as it is, and says how late it is.\n  Nothing reaches the user while the machine is off.\n- **One-shot only.** There is no recurring rule; set another alarm if you need one.\n- A failed delivery is recorded on the alarm rather than lost — `list` shows the error.\n";
/**
* Register the clock skill.
* @param skills - the ctx.skills registry.
* @returns the disposer removing the skill.
*/
function registerSkill(skills) {
	return skills.register({
		name: SKILL_NAME,
		description: SKILL_DESCRIPTION,
		whenToUse: SKILL_WHEN_TO_USE,
		source: "bundled",
		invocation: {
			modelInvocable: true,
			userInvocable: true
		},
		content: SKILL_BODY
	});
}
//#endregion
//#region src/index.ts
/** Cordis plugin name. */
const name = "clock";
/**
* The services this plugin cannot work without.
*
* Cordis refuses to read a service property from a context that never declared
* it, and that refusal happens at plugin-apply time — so an undeclared
* dependency is a boot failure rather than a degraded feature. The sessions and
* tools services are mounted by dsh-base in every profile, so requiring them
* costs nothing. The session controller is deliberately NOT listed: it is the
* service that actually performs a wake, but it is registered by the Web
* Session controller rather than by the base profile, and declaring it would
* stop the panel from existing at all in a profile that lacks it. It is
* resolved lazily at delivery time instead, and the panel reports the wake
* path as unavailable when it is missing.
*/
const inject = ["sessions", "tools"];
/**
* Read an optional service without declaring it in the inject list.
*
* Cordis exposes ctx.get(name) for exactly this: a missing service yields
* undefined instead of the inject refusal a property read would raise.
* @param ctx - the plugin context.
* @param name - service name.
* @returns the service, or undefined when the profile does not mount it.
*/
function optionalService(ctx, name) {
	const direct = ctx.get;
	if (typeof direct === "function") try {
		const value = direct.call(ctx, name);
		if (value !== void 0) return value;
	} catch {}
	const reflect = ctx.reflect;
	if (reflect !== void 0 && typeof reflect.get === "function") try {
		return reflect.get(name, false);
	} catch {
		return;
	}
}
/**
* Mount the host half.
* @param ctx - the plugin cordis context.
* @param config - optional plugin configuration from the profile row.
*/
function apply(ctx, config) {
	if (ctx.sessions === void 0) {
		ctx.logger?.warn("[clock] sessions service unavailable; plugin not activated");
		return;
	}
	const service = new ClockService({
		ctx,
		config
	});
	service.start();
	ctx.effect?.(() => () => {
		service.dispose();
	}, "clock: lifecycle");
	const controller = optionalService(ctx, "sessionController");
	if (controller === void 0) ctx.logger?.warn("[clock] sessionController unavailable: alarms can be created and listed, but waking is disabled");
	if (service.config.useSystemScheduler && !systemSchedulerSupported()) ctx.logger?.info?.("[clock] OS scheduler mirror unavailable on this platform; using the in-process timer only");
	const api = mountApi(ctx, service);
	const tool = service.config.exposeTool ? mountTool(ctx, service) : "disabled";
	const skill = mountSkill(ctx);
	service.note("apply: sessionController=" + (controller === void 0 ? "missing" : "present") + " tool=" + tool + " api=" + api + " skill=" + skill + " systemScheduler=" + String(service.config.useSystemScheduler && systemSchedulerSupported()));
}
/**
* Mount the HTTP surface on whichever carrier this profile has.
* @returns which carrier took it, for the startup log.
*/
function mountApi(ctx, service) {
	const deps = { service };
	const webServer = optionalService(ctx, "webServer");
	if (webServer !== void 0 && typeof webServer.register === "function") try {
		const dispose = registerWebRoute(webServer, deps);
		ctx.effect?.(() => () => dispose(), "clock: web route");
		ctx.logger?.info?.("[clock] mounted at /api/clock");
		return "webroute";
	} catch (error) {
		ctx.logger?.warn?.("[clock] mounting the webServer route failed; falling back to a local port: " + String(error));
	}
	startStandaloneServer(deps).then((server) => {
		ctx.effect?.(() => () => {
			server.close();
		}, "clock: standalone server");
		ctx.logger?.info?.("[clock] local API http://127.0.0.1:" + service.config.port);
	}).catch((error) => {
		ctx.logger?.warn?.("[clock] local API port unavailable: " + String(error));
	});
	return "standalone";
}
/**
* Contribute the clock skill to the agent's skill catalog.
*
* The tool is advertised by one line; the skill is how another conversation
* learns the parts that one line cannot carry - that a target may be a closed
* conversation, that it keeps its own id, and that an alarm set while the host
* is down arrives late and says so.
* @param ctx - the plugin context.
* @returns the outcome, for the startup log.
*/
function mountSkill(ctx) {
	const skills = optionalService(ctx, "skills");
	if (skills === void 0 || typeof skills.register !== "function") return "no-registry";
	try {
		const dispose = registerSkill(skills);
		ctx.effect?.(() => () => dispose(), "clock: clock skill");
		return "registered";
	} catch (error) {
		ctx.logger?.warn?.("[clock] registering the clock skill failed: " + String(error));
		return "threw:" + String(error).slice(0, 120);
	}
}
/**
* Register the model-facing clock tool when a tool registry exists.
*
* The injected property is tried before the reflective lookup on purpose. The
* `tools` service is declared in `inject`, so cordis has already placed it on
* the context as a property; the reflective `ctx.get()` path is a fallback for
* versions that expose it differently, not the primary route.
* @param ctx - the plugin context.
* @param service - the clock service.
* @returns the outcome, for the startup log.
*/
function mountTool(ctx, service) {
	const tools = ctx.tools ?? optionalService(ctx, "tools");
	if (tools === void 0) return "no-registry";
	if (typeof tools.register !== "function") return "registry-without-register";
	try {
		const dispose = registerTool(tools, service);
		ctx.effect?.(() => () => dispose(), "clock: clock tool");
		return "registered";
	} catch (error) {
		ctx.logger?.warn?.("[clock] registering the clock tool failed: " + String(error));
		return "threw:" + String(error).slice(0, 120);
	}
}
//#endregion
export { apply, inject, name };
