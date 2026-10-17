import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";
//#region src/host/store.ts
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
//#endregion
//#region src/host/officialStore.ts
/**
* Map one official record onto the alarm the panel draws.
*
* `origin` and `createdAt` have no official counterpart and are not optional in
* the panel's type. Both are filled with the truth as far as it is knowable:
* every alarm this plugin surfaces was created by the user, and the only time
* the record carries is the instant it was scheduled for.
* @param entry - the record with its session binding.
* @param now - the clock, injected for tests.
* @param defaultZone - zone to use when the record names none.
* @returns the alarm.
*/
function toClockAlarm(entry, now, defaultZone) {
	const parsed = entry.scheduledAt === void 0 ? NaN : Date.parse(entry.scheduledAt);
	const at = Number.isFinite(parsed) ? parsed : 0;
	const state = entry.state ?? "scheduled";
	const delivered = entry.status === "inactive" || entry.lastDelivery !== void 0;
	const status = delivered ? "fired" : state === "overdue" && at <= now ? "fired" : "pending";
	return {
		id: entry.id,
		at,
		timeZone: entry.timeZone ?? defaultZone,
		keyword: entry.title,
		note: entry.prompt,
		sessionId: entry.sessionId,
		origin: "user",
		createdAt: at,
		status,
		...delivered ? { firedAt: at } : {}
	};
}
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
//#endregion
//#region src/host/service.ts
/**
* The clock plugin's service, backed by the harness schedule service.
*
* dsh 0.2.x ships `ctx.schedule`: durable records, host-side delivery, a UI and
* a model-facing tool. This plugin grew its own alarm store, its own delivery
* engine and a PowerShell task mirror before any of that existed. Two delivery
* paths for one reminder is how a reminder fires twice, or not at all, so the
* engine is gone and the records are the harness's.
*
* What remains here is the part the harness has no opinion about: which
* conversations exist, what they are called, and how the panel words a wake.
*
* @module dsh-clock/host/service
*/
/** Turn a snapshot accessor's result into typed events. */
function normalizeEvents(raw) {
	const events = [];
	for (const item of raw ?? []) {
		if (item === null || typeof item !== "object") continue;
		const candidate = item;
		events.push({
			type: typeof candidate.type === "string" ? candidate.type : void 0,
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
* Branches whose parent still carries pending alarms.
*
* Branching copies the conversation, not the alarm table: an alarm set before
* the branch keeps pointing at the parent, so the branch is silently never
* woken. That is the case worth interrupting a human for.
* @param rows - the conversation picker rows.
* @param alarms - the alarms currently in force.
* @param dismissed - branches the human already waved away.
* @returns the branches to ask about.
*/
function forkPrompts(rows, alarms, dismissed = /* @__PURE__ */ new Set()) {
	const pending = alarms.filter((alarm) => alarm.status === "pending");
	if (pending.length === 0) return [];
	const byId = new Map(rows.map((row) => [row.id, row]));
	const out = [];
	for (const row of rows) {
		const parentId = row.parentSession;
		if (parentId === void 0 || parentId === "" || dismissed.has(row.id)) continue;
		const parent = byId.get(parentId);
		if (parent === void 0) continue;
		const inherited = pending.filter((alarm) => alarm.sessionId === parentId);
		if (inherited.length === 0) continue;
		if (pending.some((alarm) => alarm.sessionId === row.id)) continue;
		out.push({
			sessionId: row.id,
			title: row.title,
			parentId,
			parentTitle: parent.title,
			alarms: inherited.length
		});
	}
	return out;
}
/** Whether a session is a subagent's, which the picker must not offer. */
function isSubagentSession(header) {
	return header?.origin === "subagent";
}
/** The service. */
var ClockService = class {
	config;
	ctx;
	started = false;
	storedTitles = /* @__PURE__ */ new Map();
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
	dismissedForks = /* @__PURE__ */ new Set();
	/** Why the last catalogue read failed, surfaced through state(). */
	lastListError;
	/** @param deps - context and optional configuration. */
	constructor(deps) {
		this.ctx = deps.ctx;
		this.config = resolveConfig(deps.config);
	}
	/**
	* Append one line to the plugin's startup log.
	* @param message - the line to record.
	*/
	note(message) {
		try {
			mkdirSync(this.config.dataDir, { recursive: true });
			appendFileSync(join(this.config.dataDir, "startup.log"), (/* @__PURE__ */ new Date()).toISOString() + " " + message + "\n");
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
	/** The schedule service, when the composition provides one. */
	schedule() {
		return this.ctx.get?.("schedule");
	}
	/**
	* Every alarm in force, read from the official records.
	* @returns the alarms, soonest first.
	*/
	async listAlarms() {
		const schedule = this.schedule();
		if (schedule === void 0) {
			this.lastListError = "the schedule service is not available in this profile";
			return [];
		}
		try {
			const records = await schedule.catalog();
			this.lastListError = void 0;
			const now = this.now();
			const zone = this.timeZone;
			return records.map((record) => toClockAlarm(record, now, zone)).sort((left, right) => left.at - right.at);
		} catch (error) {
			this.lastListError = String(error).slice(0, 300);
			this.log("schedule.catalog failed: " + this.lastListError);
			return [];
		}
	}
	/** Start the background title read. Alarms need no arming: the harness owns them. */
	start() {
		if (this.started) return;
		this.started = true;
		this.refreshStoredTitles();
	}
	/** The conversation's session store, when resolvable. */
	persistence() {
		return this.ctx.get?.("sessionPersistence");
	}
	/**
	* Live and stored conversations, newest first.
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
				updatedAt: last === void 0 ? session.header?.createdAt ?? 0 : last.time ?? 0,
				cold: false,
				parentSession: session.header?.parentSession
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
					cold: true,
					parentSession: snapshot.header?.parentSession
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
	* make the picker slow, so this runs once and is purely additive: rows are
	* usable by id before it finishes.
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
	/**
	* Create one alarm through the official service.
	* @param input - what the panel collected.
	* @returns the created alarm.
	*/
	async create(input) {
		const schedule = this.schedule();
		if (schedule === void 0) return void 0;
		const title = (input.label ?? input.keyword).trim() === "" ? "reminder" : (input.label ?? input.keyword).trim().slice(0, 120);
		const prompt = (input.note ?? "").trim() === "" ? input.keyword : input.note ?? "";
		return toClockAlarm(await schedule.create(input.sessionId, {
			title,
			prompt,
			at: new Date(input.at).toISOString()
		}), this.now(), this.timeZone);
	}
	/**
	* Move a pending alarm to a new instant.
	* @param id - alarm identity.
	* @param at - the new instant.
	* @returns the updated alarm, or undefined when it is gone.
	*/
	async update(id, patch) {
		const schedule = this.schedule();
		if (schedule === void 0) return void 0;
		const request = { id };
		if (patch.at !== void 0) request.at = new Date(patch.at).toISOString();
		if (patch.keyword !== void 0) request.title = patch.keyword;
		if (patch.note !== void 0) request.prompt = patch.note;
		try {
			await schedule.update(request);
		} catch (error) {
			this.log("schedule.update failed: " + String(error));
			return;
		}
		return (await this.listAlarms()).find((alarm) => alarm.id === id);
	}
	/**
	* Drop an alarm entirely. The official service has no "cancelled but visible"
	* state, so cancelling is deleting; the row is gone after the next read.
	* @param id - alarm identity.
	* @returns whether a record was removed.
	*/
	async forget(id) {
		const schedule = this.schedule();
		if (schedule === void 0) return false;
		try {
			await schedule.delete({ id });
			return true;
		} catch (error) {
			this.log("schedule.delete failed: " + String(error));
			return false;
		}
	}
	/** Forget a branch question until the next restart. */
	dismissFork(sessionId) {
		this.dismissedForks.add(sessionId);
	}
	/**
	* Copy a conversation's pending alarms onto a branch of it.
	*
	* The official record binds one session, so a branch inherits nothing; each
	* pending alarm is re-created against the branch with the same instant and
	* wording. Coverage is judged by "the branch already has an alarm at this
	* instant with this title", which is weaker than the identity the old store
	* carried and is stated here rather than hidden.
	* @param sessionId - the branch to arm.
	* @returns how many alarms were copied.
	* @throws when the conversation is unknown or did not branch.
	*/
	async copyAlarmsToFork(sessionId) {
		const branch = (await this.listSessions()).find((row) => row.id === sessionId);
		if (branch === void 0) throw new Error("no conversation " + sessionId);
		const parentId = branch.parentSession;
		if (parentId === void 0 || parentId === "") throw new Error("conversation " + sessionId + " did not branch from another one");
		const alarms = await this.listAlarms();
		const parentPending = alarms.filter((alarm) => alarm.status === "pending" && alarm.sessionId === parentId);
		const branchPending = alarms.filter((alarm) => alarm.status === "pending" && alarm.sessionId === sessionId);
		let copied = 0;
		for (const alarm of parentPending) {
			if (branchPending.some((row) => row.at === alarm.at && row.keyword === alarm.keyword)) continue;
			if (await this.create({
				at: alarm.at,
				timeZone: alarm.timeZone,
				keyword: alarm.keyword,
				note: alarm.note,
				sessionId,
				label: alarm.label
			}) !== void 0) copied += 1;
		}
		return copied;
	}
	/** Everything the panel renders in one read. */
	async state() {
		const sessions = await this.listSessions();
		const alarms = await this.listAlarms();
		const now = this.now();
		const nextDue = alarms.filter((alarm) => alarm.status === "pending").reduce((soonest, alarm) => soonest === null || alarm.at < soonest ? alarm.at : soonest, null);
		return {
			now,
			timeZone: this.timeZone,
			alarms,
			sessions,
			scheduler: {
				systemScheduler: false,
				systemTaskArmedFor: null,
				timerArmedFor: nextDue,
				...this.lastListError === void 0 ? {} : { lastSyncError: "catalogue read failed: " + this.lastListError }
			},
			forks: forkPrompts(sessions, alarms, this.dismissedForks),
			titleIndex: { ...this.titleIndex },
			config: {
				port: this.config.port,
				dataDir: this.config.dataDir,
				defaultTimeZone: this.timeZone,
				wakeMode: this.config.wakeMode
			}
		};
	}
	/** Nothing to release: the harness owns the timers. */
	async dispose() {}
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
		if (method === "POST" && path === "/alarms/cancel") return await service.forget(requiredString(body, "id")) ? ok({
			id: requiredString(body, "id"),
			status: "cancelled"
		}) : fail(404, "no alarm with that id");
		if (method === "POST" && path === "/alarms/forget") return await service.forget(requiredString(body, "id")) ? ok({ removed: true }) : fail(404, "no alarm with that id");
		if (method === "POST" && path === "/alarms/fire") return fail(501, "manual firing is not offered: the harness delivers alarms");
		if (method === "POST" && path === "/alarms/fork-copy") return ok({ copied: await service.copyAlarmsToFork(requiredString(body, "sessionId")) });
		if (method === "POST" && path === "/alarms/fork-dismiss") {
			service.dismissFork(requiredString(body, "sessionId"));
			return ok({ dismissed: true });
		}
		if (method === "POST" && path === "/client-log") {
			const message = typeof body.message === "string" ? body.message.slice(0, 400) : "";
			if (message !== "") service.note("client: " + message);
			return ok({ recorded: message !== "" });
		}
		if (method === "POST" && path === "/tick") return fail(501, "the harness schedules alarms; this plugin no longer owns a timer");
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
				"update",
				"list",
				"cancel"
			],
			description: "now reads the current time. set creates a wake-up. update changes one that is still pending. list shows alarms. cancel removes pending ones."
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
		description: "Schedule a wake-up: when a chosen instant passes, a message carrying a keyword is delivered into a conversation — by default this one, or another conversation by id. Use it to come back to work at a set time. update changes an alarm that has not fired yet; only its own fields change, and a new instant re-arms it. A wake delivered late says so, including the scheduled time, the actual time, and the drift.",
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
				if (alarm === void 0) throw new Error("the schedule service is not available in this profile");
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
				const rows = (await service.listAlarms()).map((alarm) => toRow(alarm, now));
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
					const mine = (await service.listAlarms()).filter((alarm) => alarm.status === "pending" && alarm.sessionId === callingSession);
					for (const alarm of mine) await service.forget(alarm.id);
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
				const found = (await service.listAlarms()).find((row) => row.id === id);
				if (found === void 0) throw new Error("no alarm with id " + id);
				await service.forget(id);
				const cancelled = {
					...found,
					status: "cancelled"
				};
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
			if (action === "update") {
				const id = typeof args.id === "string" ? args.id.trim() : "";
				if (id === "") throw new Error("pass id, plus whichever fields should change");
				const existing = (await service.listAlarms()).find((row) => row.id === id);
				if (existing === void 0) throw new Error("no alarm with id " + id);
				if (existing.status !== "pending") throw new Error("alarm " + id + " is " + existing.status + "; only a pending alarm can be edited");
				const patch = {};
				if (typeof args.afterSeconds === "number" && Number.isFinite(args.afterSeconds)) patch.at = now + Math.round(args.afterSeconds * 1e3);
				else if (typeof args.at === "string" && args.at.trim() !== "") {
					const parsed = Date.parse(args.at);
					if (Number.isNaN(parsed)) throw new Error("at must be a parseable ISO-8601 instant with an explicit offset");
					patch.at = parsed;
				}
				if (typeof args.timeZone === "string" && isValidTimeZone(args.timeZone)) patch.timeZone = args.timeZone;
				if (typeof args.keyword === "string" && args.keyword.trim() !== "") patch.keyword = args.keyword.trim();
				if (typeof args.note === "string") patch.note = args.note.trim() === "" ? void 0 : args.note.trim();
				if (typeof args.label === "string") patch.label = args.label.trim() === "" ? void 0 : args.label.trim();
				if (typeof args.sessionId === "string" && args.sessionId.trim() !== "") patch.sessionId = args.sessionId.trim();
				if (Object.keys(patch).length === 0) throw new Error("nothing to change: pass at, afterSeconds, keyword, note, label or sessionId");
				const updated = await service.update(id, patch);
				if (updated === void 0) throw new Error("no alarm with id " + id);
				notes.push("A changed instant re-arms both trigger layers immediately.");
				return {
					action,
					summary: "Alarm " + id + " updated: " + isoInZone(updated.at, updated.timeZone) + " keyword \"" + updated.keyword + "\".",
					sessionId: callingSession,
					timeZone: updated.timeZone,
					now: isoInZone(now, updated.timeZone),
					alarms: [toRow(updated, now)],
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
* The body is assembled from an array rather than written as one long string
* literal: it is markdown full of backticks, quotes and blank lines, and every
* one of those is an escaping mistake waiting to happen inside a literal.
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
const SKILL_BODY = [
	"# clock — schedule a wake-up",
	"",
	"`clock` schedules a message to arrive in a conversation at a chosen instant. The message opens",
	"with a keyword you choose, and it carries the scheduled time, the actual time, and the signed",
	"drift, so the conversation that gets woken can tell \"on time\" from \"three hours late\".",
	"",
	"## When to use it",
	"",
	"- The user says \"remind me\", \"come back to this in an hour\", \"check the build at 17:00\".",
	"- You are starting something slow and know you should return to it.",
	"- Work should resume later in a **different** conversation, including one that is currently",
	"  closed. That is the case this exists for: the harness's own reminders are session-local and",
	"  cannot reach a conversation nobody has open.",
	"",
	"Do not use it as a notification channel. It delivers into a dsh conversation — not to a phone,",
	"not by mail, not by push.",
	"",
	"## Actions",
	"",
	"| action | what it does |",
	"| --- | --- |",
	"| `now` | the current time, in a zone |",
	"| `set` | create a wake-up |",
	"| `update` | change one that is still pending — instant, keyword, content, or target |",
	"| `list` | pending and recent alarms, with any delivery error |",
	"| `cancel` | cancel one by `id`, or `all: true` for every pending alarm of this conversation |",
	"",
	"## Setting one",
	"",
	"Relative delay, waking this conversation:",
	"",
	"    clock { action: \"set\", afterSeconds: 2700, keyword: \"check the build\",",
	"            note: \"the release job should be done by now\" }",
	"",
	"Absolute instant, waking another conversation — including a closed one:",
	"",
	"    clock { action: \"set\", at: \"2026-09-11T09:30:00+08:00\", timeZone: \"Asia/Shanghai\",",
	"            keyword: \"standup\", sessionId: \"session-…\" }",
	"",
	"`sessionId` defaults to the calling conversation. A closed target is resumed before the message",
	"lands and **keeps its own id** — it is continued, not forked. Give `at` an explicit offset, or",
	"pass `timeZone`, because an unqualified local time is a guess about which machine meant it.",
	"",
	"## Changing one that has not fired yet",
	"",
	"    clock { action: \"update\", id: \"a-…\", afterSeconds: 600, keyword: \"try again\",",
	"            note: \"\" }",
	"",
	"Pass only the fields that should change. `note: \"\"` clears the note; omitting `note` leaves it",
	"alone. A new instant re-arms both trigger layers immediately.",
	"",
	"`update` refuses an alarm that already fired or was cancelled. Editing one would promise a",
	"delivery that is not going to happen — set a new one instead.",
	"",
	"## Branches",
	"",
	"Branching a conversation copies the conversation, not the alarm table. An alarm set before the",
	"branch keeps pointing at the parent, so the branch is silently never woken. The panel notices a",
	"branch whose parent still carries pending alarms and asks once - copy the alarms onto the branch,",
	"or decline. Either way the question is not asked again: an armed branch is covered, and a declined",
	"one is remembered on disk.",
	"",
	"If you are asked to sort out a branch yourself, the tool has no fork action: copying is done from",
	"the panel, and a copy is an ordinary alarm whose `copyOf` records where it came from.",
	"",
	"## What the woken conversation receives",
	"",
	"    ⏰ dsh-clock wake — keyword: check the build",
	"",
	"    scheduled  2026-09-11T09:30:00+08:00  [Asia/Shanghai]",
	"    now        2026-09-11T11:43:12+08:00  [Asia/Shanghai]",
	"    drift      +2h13m  OVERDUE",
	"    trigger    in-process timer",
	"",
	"    warning    OVERDUE by +2h13m: the host was not running at the scheduled instant …",
	"    note       This message was delivered by a timer, not typed by the user. …",
	"    detail     the release job should be done by now",
	"",
	"## Limits worth stating before you rely on one",
	"",
	"- **The host must be running.** Only the host can resume a conversation, so if dsh web is not up",
	"  at the scheduled instant the alarm is delivered as soon as it is, and says how late it is.",
	"  Nothing reaches the user while the machine is off.",
	"- **One-shot only.** There is no recurring rule; set another alarm if you need one.",
	"- A failed delivery is recorded on the alarm rather than lost — `list` shows the error.",
	""
].join("\n");
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
	const api = mountApi(ctx, service);
	const tool = service.config.exposeTool ? mountTool(ctx, service) : "disabled";
	const skill = mountSkill(ctx);
	service.note("apply: sessionController=" + (controller === void 0 ? "missing" : "present") + " tool=" + tool + " api=" + api + " skill=" + skill + " delivery=harness");
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
