window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-client-plugin-clock",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_dom_client = require("react-dom/client");
		//#region \0dsh-css:src/client/clock.module.css.mjs
		const css = "._8SpRlq_panel{--surface:#16181d;--surface-2:#1e2128;--surface-3:#272b34;--border:#333844;--text:#e8eaf0;--muted:#9aa3b2;--accent:#6ea8fe;--accent-soft:#6ea8fe29;--danger:#ef6b6b;--ok:#5ec98a;--warn:#e2b04a}@media (prefers-color-scheme:light){._8SpRlq_panel{--surface:#fff;--surface-2:#f5f6f8;--surface-3:#eceef2;--border:#dcdfe6;--text:#1d2026;--muted:#666e7d;--accent:#2f6fdc;--accent-soft:#2f6fdc1f;--danger:#c0392b;--ok:#1f8a4c;--warn:#a9761a}}._8SpRlq_launcher{border:1px solid var(--border);background:var(--surface);width:42px;height:42px;color:var(--text);cursor:grab;user-select:none;border-radius:50%;justify-content:center;align-items:center;transition:transform .12s,border-color .12s;display:flex;position:fixed;box-shadow:0 4px 14px #00000047}._8SpRlq_launcher:hover{border-color:var(--accent);transform:scale(1.06)}._8SpRlq_launcher:active{cursor:grabbing}._8SpRlq_sidebarButton{white-space:nowrap;min-height:28px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary,currentColor));cursor:pointer;font:inherit;text-align:left;opacity:.85;background:0 0;border:1px solid #7f7f7f59;border-radius:6px;justify-content:center;align-items:center;gap:6px;padding:0 10px;font-size:13px;display:flex}._8SpRlq_sidebarButton:hover,._8SpRlq_sidebarButtonActive{opacity:1;background:#7f7f7f24}._8SpRlq_sidebarIcon{font-size:15px;line-height:1}._8SpRlq_sidebarLabel{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._8SpRlq_panel{z-index:2147483000;background:var(--surface);border:1px solid var(--border);width:min(620px,100vw - 32px);max-height:min(92vh,880px);color:var(--text);border-radius:14px;flex-direction:column;font-family:ui-sans-serif,system-ui,Segoe UI,Microsoft YaHei,sans-serif;font-size:13px;line-height:1.5;display:flex;position:fixed;top:50%;left:50%;overflow:hidden;transform:translate(-50%,-50%);box-shadow:0 24px 64px #00000080}._8SpRlq_header{border-bottom:1px solid var(--border);background:var(--surface-2);align-items:center;gap:8px;padding:12px 14px;display:flex}._8SpRlq_title{font-size:14px;font-weight:650}._8SpRlq_headerSpacer{flex:1}._8SpRlq_iconButton{color:var(--muted);cursor:pointer;background:0 0;border:1px solid #0000;border-radius:7px;padding:3px 7px;font-size:14px;line-height:1}._8SpRlq_iconButton:hover{color:var(--text);background:var(--surface-3)}._8SpRlq_clock{border-bottom:1px solid var(--border);align-items:flex-end;gap:12px;padding:14px;display:flex}._8SpRlq_clockTime{font-variant-numeric:tabular-nums;letter-spacing:.5px;font-size:30px;font-weight:600}._8SpRlq_clockMeta{padding-bottom:4px}._8SpRlq_clockDate{color:var(--text)}._8SpRlq_clockZone{color:var(--muted);font-size:11px}._8SpRlq_nextAlarm{text-align:right;margin-left:auto;padding-bottom:3px}._8SpRlq_nextLabel{color:var(--muted);font-size:11px}._8SpRlq_nextValue{color:var(--accent);font-variant-numeric:tabular-nums;font-weight:600}._8SpRlq_nextValueIdle{color:var(--muted);font-weight:400}._8SpRlq_calendar{padding:10px 12px 4px}._8SpRlq_calendarBar{align-items:center;gap:6px;margin-bottom:6px;display:flex}._8SpRlq_monthLabel{font-weight:600}._8SpRlq_weekdays,._8SpRlq_days{grid-template-columns:repeat(7,1fr);gap:2px;display:grid}._8SpRlq_weekdays{color:var(--muted);text-align:center;margin-bottom:3px;font-size:11px}._8SpRlq_day{aspect-ratio:1;color:var(--text);cursor:pointer;background:0 0;border:1px solid #0000;border-radius:8px;justify-content:center;align-items:center;padding:0;font-size:12px;display:flex;position:relative}._8SpRlq_day:hover{background:var(--surface-3)}._8SpRlq_dayOutside{color:var(--muted);opacity:.5}._8SpRlq_dayToday{border-color:var(--accent)}._8SpRlq_daySelected{background:var(--accent-soft);border-color:var(--accent)}._8SpRlq_dot{background:var(--accent);border-radius:50%;width:4px;height:4px;position:absolute;bottom:3px;left:50%;transform:translate(-50%)}._8SpRlq_dotFired{background:var(--ok)}._8SpRlq_body{overscroll-behavior:contain;flex:auto;min-height:0;overflow-y:auto}._8SpRlq_alarmPanel{border-top:1px solid var(--border);grid-template-columns:1fr 1fr;gap:10px;padding:10px 12px;display:grid}@media (width<=700px){._8SpRlq_alarmPanel{grid-template-columns:1fr}}._8SpRlq_column{flex-direction:column;min-width:0;display:flex}._8SpRlq_columnHead{color:var(--muted);border-bottom:1px solid var(--border);justify-content:space-between;align-items:center;margin-bottom:6px;padding:0 2px 5px;font-size:11px;font-weight:600;display:flex}._8SpRlq_columnBody{max-height:200px;padding-right:2px;overflow-y:auto}._8SpRlq_header{flex:none}._8SpRlq_empty{color:var(--muted);text-align:center;padding:14px 0}._8SpRlq_alarm{border:1px solid var(--border);background:var(--surface-2);border-radius:9px;align-items:flex-start;gap:9px;margin-bottom:6px;padding:8px;display:flex}._8SpRlq_alarmFired{opacity:.62}._8SpRlq_alarmCancelled{opacity:.45;text-decoration:line-through}._8SpRlq_alarmTime{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}._8SpRlq_alarmBody{flex:1;min-width:0}._8SpRlq_alarmKeyword{text-overflow:ellipsis;white-space:nowrap;font-weight:600;overflow:hidden}._8SpRlq_alarmMeta{color:var(--muted);text-overflow:ellipsis;white-space:nowrap;font-size:11px;overflow:hidden}._8SpRlq_alarmError{color:var(--danger);font-size:11px}._8SpRlq_alarmActions{flex:none;align-items:flex-start;gap:4px;display:flex}._8SpRlq_pill{border:1px solid var(--border);color:var(--muted);border-radius:999px;margin-right:4px;padding:0 6px;font-size:10px;display:inline-block}._8SpRlq_pillLate{color:var(--warn);border-color:var(--warn)}._8SpRlq_pillOk{color:var(--ok);border-color:var(--ok)}._8SpRlq_form{border-top:1px solid var(--border);background:var(--surface-2);padding:10px 12px 12px}._8SpRlq_formRow{gap:6px;display:flex}._8SpRlq_field{margin-bottom:8px}._8SpRlq_fieldLabel{color:var(--muted);margin-bottom:3px;font-size:11px;display:block}._8SpRlq_fieldRow{gap:6px;display:flex}._8SpRlq_inputDate{flex:60%;min-width:0}._8SpRlq_inputTimeFlex{flex:40%;min-width:0}._8SpRlq_buttonBlock{width:100%;margin-top:2px;padding:9px 12px;display:block}._8SpRlq_editingBanner{background:var(--accent-soft);color:var(--accent);border-radius:6px;margin-bottom:8px;padding:5px 8px;font-size:11px}._8SpRlq_smallButton,._8SpRlq_smallButtonDanger{border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;cursor:pointer;white-space:nowrap;border-radius:6px;padding:3px 9px;font-size:11px;line-height:1.6}._8SpRlq_smallButton:hover{border-color:var(--accent);color:var(--accent)}._8SpRlq_smallButtonDanger:hover{border-color:var(--danger);color:var(--danger)}._8SpRlq_input,._8SpRlq_select,._8SpRlq_textarea{background:var(--surface);border:1px solid var(--border);width:100%;color:var(--text);font:inherit;border-radius:7px;outline:none;padding:6px 8px}._8SpRlq_input:focus,._8SpRlq_select:focus,._8SpRlq_textarea:focus{border-color:var(--accent)}._8SpRlq_textarea{resize:vertical;min-height:34px}._8SpRlq_inputTime{flex:0 0 104px}._8SpRlq_button{border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;cursor:pointer;white-space:nowrap;border-radius:8px;padding:6px 12px;font-weight:600}._8SpRlq_button:disabled{opacity:.5;cursor:default}._8SpRlq_buttonGhost{color:var(--accent);background:0 0}._8SpRlq_error{color:var(--danger);margin-top:5px;font-size:11px}._8SpRlq_hint{color:var(--muted);margin-top:5px;font-size:11px}";
		const tagId = "@dsh-external/dsh-client-plugin-clock/clock.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/dsh-client-plugin-clock";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var clock_module_css_default = {
			"alarm": "_8SpRlq_alarm",
			"alarmActions": "_8SpRlq_alarmActions",
			"alarmBody": "_8SpRlq_alarmBody",
			"alarmCancelled": "_8SpRlq_alarmCancelled",
			"alarmError": "_8SpRlq_alarmError",
			"alarmFired": "_8SpRlq_alarmFired",
			"alarmKeyword": "_8SpRlq_alarmKeyword",
			"alarmMeta": "_8SpRlq_alarmMeta",
			"alarmPanel": "_8SpRlq_alarmPanel",
			"alarmTime": "_8SpRlq_alarmTime",
			"body": "_8SpRlq_body",
			"button": "_8SpRlq_button",
			"buttonBlock": "_8SpRlq_buttonBlock",
			"buttonGhost": "_8SpRlq_buttonGhost",
			"calendar": "_8SpRlq_calendar",
			"calendarBar": "_8SpRlq_calendarBar",
			"clock": "_8SpRlq_clock",
			"clockDate": "_8SpRlq_clockDate",
			"clockMeta": "_8SpRlq_clockMeta",
			"clockTime": "_8SpRlq_clockTime",
			"clockZone": "_8SpRlq_clockZone",
			"column": "_8SpRlq_column",
			"columnBody": "_8SpRlq_columnBody",
			"columnHead": "_8SpRlq_columnHead",
			"day": "_8SpRlq_day",
			"dayOutside": "_8SpRlq_dayOutside",
			"daySelected": "_8SpRlq_daySelected",
			"dayToday": "_8SpRlq_dayToday",
			"days": "_8SpRlq_days",
			"dot": "_8SpRlq_dot",
			"dotFired": "_8SpRlq_dotFired",
			"editingBanner": "_8SpRlq_editingBanner",
			"empty": "_8SpRlq_empty",
			"error": "_8SpRlq_error",
			"field": "_8SpRlq_field",
			"fieldLabel": "_8SpRlq_fieldLabel",
			"fieldRow": "_8SpRlq_fieldRow",
			"form": "_8SpRlq_form",
			"formRow": "_8SpRlq_formRow",
			"header": "_8SpRlq_header",
			"headerSpacer": "_8SpRlq_headerSpacer",
			"hint": "_8SpRlq_hint",
			"iconButton": "_8SpRlq_iconButton",
			"input": "_8SpRlq_input",
			"inputDate": "_8SpRlq_inputDate",
			"inputTime": "_8SpRlq_inputTime",
			"inputTimeFlex": "_8SpRlq_inputTimeFlex",
			"launcher": "_8SpRlq_launcher",
			"monthLabel": "_8SpRlq_monthLabel",
			"nextAlarm": "_8SpRlq_nextAlarm",
			"nextLabel": "_8SpRlq_nextLabel",
			"nextValue": "_8SpRlq_nextValue",
			"nextValueIdle": "_8SpRlq_nextValueIdle",
			"panel": "_8SpRlq_panel",
			"pill": "_8SpRlq_pill",
			"pillLate": "_8SpRlq_pillLate",
			"pillOk": "_8SpRlq_pillOk",
			"select": "_8SpRlq_select",
			"sidebarButton": "_8SpRlq_sidebarButton",
			"sidebarButtonActive": "_8SpRlq_sidebarButtonActive",
			"sidebarIcon": "_8SpRlq_sidebarIcon",
			"sidebarLabel": "_8SpRlq_sidebarLabel",
			"smallButton": "_8SpRlq_smallButton",
			"smallButtonDanger": "_8SpRlq_smallButtonDanger",
			"textarea": "_8SpRlq_textarea",
			"title": "_8SpRlq_title",
			"weekdays": "_8SpRlq_weekdays"
		};
		//#endregion
		//#region src/client/bus.ts
		/**
		* The one piece of shared state between the sidebar button and the panel.
		*
		* The button is mounted by the slot system inside the shell's sidebar foot,
		* while the panel is mounted on the document body by this plugin's own root.
		* They are two React trees, so a context cannot cross them; a module-level
		* store with `useSyncExternalStore` is the smallest thing that can.
		*
		* @module dsh-clock/client/bus
		*/
		let open = false;
		const listeners = /* @__PURE__ */ new Set();
		/** Whether the calendar panel is showing. */
		function isOpen() {
			return open;
		}
		/** Show or hide the panel. */
		function setOpen(value) {
			if (open === value) return;
			open = value;
			for (const listener of listeners) listener();
		}
		/** Flip the panel. */
		function toggleOpen() {
			setOpen(!open);
		}
		/** Subscribe to open-state changes. */
		function subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
		/** Read the open state from a component. */
		function useOpen() {
			return (0, react.useSyncExternalStore)(subscribe, isOpen, isOpen);
		}
		//#endregion
		//#region src/client/button.tsx
		/**
		* The calendar button in the sidebar foot, next to Settings.
		*
		* It is registered into `sidebar.footer.action`, which the sidebar shell renders
		* as a list inside the same bottom-pinned foot area as the `sidebar.settings`
		* seat that holds the Settings trigger. That is the additive seat the plugin
		* development guide recommends for a small sidebar action, and it keeps this
		* button beside Settings without replacing anything.
		*
		* The slot hands the `wide` flag, which is false while the sidebar is collapsed
		* to its 56px rail; the label is dropped then so the button stays one icon.
		*
		* @module dsh-clock/client/button
		*/
		/**
		* Render the sidebar calendar trigger.
		* @param props - the shell's slot props.
		* @returns the button element.
		*/
		function CalendarButton(props) {
			const open = useOpen();
			const className = clock_module_css_default.sidebarButton + (open ? " " + clock_module_css_default.sidebarButtonActive : "");
			return react.default.createElement("button", {
				type: "button",
				className,
				title: "时钟与日历：定时唤醒某个对话",
				"aria-label": "打开时钟与日历",
				"aria-pressed": open,
				onClick: () => toggleOpen()
			}, react.default.createElement("span", {
				className: clock_module_css_default.sidebarIcon,
				"aria-hidden": "true"
			}, "📅"), react.default.createElement("span", { className: clock_module_css_default.sidebarLabel }, "日历"));
		}
		//#endregion
		//#region src/client/clock.ts
		/** The port the host prefers for its private carrier. */
		const BASE_PORT = 4801;
		/** How many consecutive ports the host may have walked. */
		const PORT_ATTEMPTS = 8;
		const API = "/api/clock";
		let resolvedBase = null;
		/** Probe one base for a live endpoint. */
		async function probe(base) {
			try {
				return (await fetch(base + "/state", { headers: { accept: "application/json" } })).ok;
			} catch {
				return false;
			}
		}
		/** Resolve the API base, preferring the panel's own origin. */
		async function apiBase() {
			if (resolvedBase !== null) return resolvedBase;
			if (await probe(API)) {
				resolvedBase = API;
				return resolvedBase;
			}
			for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
				const candidate = "http://127.0.0.1:" + String(BASE_PORT + offset) + API;
				if (await probe(candidate)) {
					resolvedBase = candidate;
					return resolvedBase;
				}
			}
			resolvedBase = API;
			return resolvedBase;
		}
		/** The failure shape every call collapses to. */
		var ClockApiError = class extends Error {};
		/** Call one endpoint and unwrap the ok/value envelope. */
		async function call(path, body) {
			const base = await apiBase();
			const payload = await (await fetch(base + path, {
				method: body === void 0 ? "GET" : "POST",
				headers: body === void 0 ? { accept: "application/json" } : { "content-type": "application/json" },
				body: body === void 0 ? void 0 : JSON.stringify(body)
			})).json();
			if (payload.ok !== true) throw new ClockApiError(payload.error ?? "request failed");
			return payload.value;
		}
		/**
		* Tell the host what the browser half is doing.
		*
		* Deliberately silent on every failure: a diagnostic that can break the very
		* feature it is diagnosing is worse than no diagnostic, and this runs during
		* activation, where a rejected promise would be an unhandled rejection.
		* @param message - one line to record.
		*/
		function report(message) {
			(async () => {
				try {
					const base = await apiBase();
					await fetch(base + "/client-log", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ message })
					});
				} catch {}
			})();
		}
		/** Read the whole panel state. */
		function fetchState() {
			return call("/state");
		}
		/** Format an instant as HH:MM:SS in a zone. */
		function formatTime(ms, timeZone) {
			return new Intl.DateTimeFormat("zh-CN", {
				timeZone,
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hour12: false
			}).format(new Date(ms));
		}
		/** Format an instant as YYYY-MM-DD in a zone. */
		function formatDate(ms, timeZone) {
			return new Intl.DateTimeFormat("sv-SE", {
				timeZone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit"
			}).format(new Date(ms));
		}
		/** Format an instant as HH:MM in a zone. */
		function formatHm(ms, timeZone) {
			return new Intl.DateTimeFormat("zh-CN", {
				timeZone,
				hour: "2-digit",
				minute: "2-digit",
				hour12: false
			}).format(new Date(ms));
		}
		/** Signed compact countdown, e.g. \u002b2h13m or -4s. */
		function countdownText(deltaMs) {
			const sign = deltaMs < 0 ? "-" : "";
			let rest = Math.abs(Math.round(deltaMs / 1e3));
			const days = Math.floor(rest / 86400);
			rest -= days * 86400;
			const hours = Math.floor(rest / 3600);
			rest -= hours * 3600;
			const minutes = Math.floor(rest / 60);
			const seconds = rest - minutes * 60;
			const parts = [];
			if (days > 0) parts.push(String(days) + "天");
			if (hours > 0) parts.push(String(hours) + "小时");
			if (minutes > 0) parts.push(String(minutes) + "分");
			if (seconds > 0 || parts.length === 0) parts.push(String(seconds) + "秒");
			return sign + parts.join("");
		}
		/**
		* Build a Monday-first month grid.
		* @param year - calendar year.
		* @param month - 0-based month.
		* @param todayKey - today as YYYY-MM-DD, for the highlight.
		* @returns six weeks of cells, always 42 entries so the panel height is stable.
		*/
		function monthGrid(year, month, todayKey) {
			const offset = (new Date(year, month, 1).getDay() + 6) % 7;
			const cells = [];
			const start = new Date(year, month, 1 - offset);
			for (let index = 0; index < 42; index += 1) {
				const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
				const key = String(date.getFullYear()) + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
				cells.push({
					key,
					day: date.getDate(),
					inMonth: date.getMonth() === month,
					isToday: key === todayKey
				});
			}
			return cells;
		}
		/** Bucket alarms by their local calendar day, for the grid dots. */
		function alarmsByDay(alarms, timeZone) {
			const map = /* @__PURE__ */ new Map();
			for (const alarm of alarms) {
				const key = formatDate(alarm.at, alarm.timeZone === "" ? timeZone : alarm.timeZone);
				const bucket = map.get(key);
				if (bucket === void 0) map.set(key, [alarm]);
				else bucket.push(alarm);
			}
			return map;
		}
		/** Combine a YYYY-MM-DD key and an HH:MM string into an epoch instant. */
		function instantFromLocal(dayKey, time) {
			const [year, month, day] = dayKey.split("-").map((part) => Number(part));
			const [hour, minute] = time.split(":").map((part) => Number(part));
			return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, 0, 0).getTime();
		}
		//#endregion
		//#region src/client/panel.tsx
		/**
		* The calendar and clock panel.
		*
		* Layout: a live clock, a month grid that marks the days carrying alarms, the
		* alarm list, and one create form that always creates the alarm the selected
		* day and typed time describe. The panel is a body-level floating surface rather
		* than a slot, so a theme plugin reshaping the layout cannot take it away.
		*
		* @module dsh-clock/client/panel
		*/
		/** Browser zone, which is the zone the user is picking times in. */
		function browserZone() {
			try {
				return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
			} catch {
				return "UTC";
			}
		}
		/** Today as YYYY-MM-DD in the browser zone. */
		function todayKey() {
			return formatDate(Date.now(), browserZone());
		}
		/** One alarm row. */
		function AlarmRow(props) {
			const { alarm, now, onFire, onCancel, onForget, onEdit } = props;
			const late = alarm.status === "fired" && alarm.firedAt !== void 0 && alarm.firedAt - alarm.at > 6e4;
			const rowClass = clock_module_css_default.alarm + (alarm.status === "fired" ? " " + clock_module_css_default.alarmFired : "") + (alarm.status === "cancelled" ? " " + clock_module_css_default.alarmCancelled : "");
			return react.default.createElement("div", { className: rowClass }, react.default.createElement("div", { className: clock_module_css_default.alarmTime }, react.default.createElement("div", null, formatHm(alarm.at, alarm.timeZone)), react.default.createElement("div", { className: clock_module_css_default.alarmMeta }, formatDate(alarm.at, alarm.timeZone).slice(5))), react.default.createElement("div", { className: clock_module_css_default.alarmBody }, react.default.createElement("div", { className: clock_module_css_default.alarmKeyword }, alarm.keyword), react.default.createElement("div", { className: clock_module_css_default.alarmMeta }, alarm.sessionTitle !== void 0 && alarm.sessionTitle !== "" ? alarm.sessionTitle : alarm.sessionId), react.default.createElement("div", null, alarm.status === "pending" ? react.default.createElement("span", { className: clock_module_css_default.pill }, "等待中 " + countdownText(alarm.at - now)) : null, alarm.status === "fired" ? react.default.createElement("span", { className: clock_module_css_default.pill + " " + (late ? clock_module_css_default.pillLate : clock_module_css_default.pillOk) }, (late ? "迟到投递 " : "已投递 ") + (alarm.via ?? "")) : null, alarm.status === "cancelled" ? react.default.createElement("span", { className: clock_module_css_default.pill }, "已取消") : null), alarm.error !== void 0 ? react.default.createElement("div", { className: clock_module_css_default.alarmError }, "投递失败：" + alarm.error) : null, alarm.note !== void 0 ? react.default.createElement("div", { className: clock_module_css_default.alarmMeta }, alarm.note) : null), react.default.createElement("div", { className: clock_module_css_default.alarmActions }, alarm.status === "pending" ? react.default.createElement("button", {
				className: clock_module_css_default.smallButton,
				title: "不等时间到，立刻投递",
				onClick: () => onFire(alarm.id)
			}, "触发") : null, alarm.status === "pending" ? react.default.createElement("button", {
				className: clock_module_css_default.smallButton,
				title: "改时间、关键词、内容或要唤醒的对话",
				onClick: () => onEdit(alarm)
			}, "编辑") : null, alarm.status === "pending" ? react.default.createElement("button", {
				className: clock_module_css_default.smallButton,
				title: "取消这次唤醒，保留记录",
				onClick: () => onCancel(alarm.id)
			}, "取消") : null, react.default.createElement("button", {
				className: clock_module_css_default.smallButtonDanger,
				title: "删除这条记录",
				onClick: () => onForget(alarm.id)
			}, "删除")));
		}
		/** The whole panel: launcher plus the surface it opens. */
		function ClockApp() {
			const open = useOpen();
			const [state, setState] = (0, react.useState)(null);
			const [now, setNow] = (0, react.useState)(() => Date.now());
			const [cursor, setCursor] = (0, react.useState)(() => {
				const today = /* @__PURE__ */ new Date();
				return {
					year: today.getFullYear(),
					month: today.getMonth()
				};
			});
			const [selectedDay, setSelectedDay] = (0, react.useState)(() => todayKey());
			const [time, setTime] = (0, react.useState)("09:00");
			const [keyword, setKeyword] = (0, react.useState)("");
			const [note, setNote] = (0, react.useState)("");
			const [sessionId, setSessionId] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			/** Alarm currently loaded into the form, or null when creating a new one. */
			const [editingId, setEditingId] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const zone = state === null ? browserZone() : state.timeZone;
			const refresh = (0, react.useCallback)(async () => {
				try {
					const next = await fetchState();
					setState(next);
					setError("");
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
				}
			}, []);
			(0, react.useEffect)(() => {
				const tick = window.setInterval(() => setNow(Date.now()), 1e3);
				return () => window.clearInterval(tick);
			}, []);
			(0, react.useEffect)(() => {
				if (!open) return void 0;
				refresh();
				const poll = window.setInterval(() => {
					refresh();
				}, 3e4);
				return () => window.clearInterval(poll);
			}, [open, refresh]);
			(0, react.useEffect)(() => {
				if (state === null) return;
				const pending = state.sessions.filter((row) => row.cold === false);
				if (sessionId === "" && pending.length > 0) setSessionId(pending[0].id);
			}, [state, sessionId]);
			const alarms = state === null ? [] : state.alarms;
			const pendingAlarms = (0, react.useMemo)(() => alarms.filter((alarm) => alarm.status === "pending").sort((left, right) => left.at - right.at), [alarms]);
			const settledAlarms = (0, react.useMemo)(() => alarms.filter((alarm) => alarm.status !== "pending").sort((left, right) => (right.firedAt ?? right.at) - (left.firedAt ?? left.at)), [alarms]);
			const byDay = (0, react.useMemo)(() => alarmsByDay(alarms, zone), [alarms, zone]);
			const grid = (0, react.useMemo)(() => monthGrid(cursor.year, cursor.month, todayKey()), [cursor.year, cursor.month]);
			const nextPending = (0, react.useMemo)(() => {
				const pending = alarms.filter((alarm) => alarm.status === "pending").sort((a, b) => a.at - b.at);
				return pending.length === 0 ? null : pending[0];
			}, [alarms]);
			/**
			* Load a pending alarm into the form.
			*
			* The day and time are rendered in the BROWSER zone, not the alarm's own,
			* because the form reads them back through a browser-local Date. Rendering
			* them in another zone would make opening an alarm and saving it unchanged
			* silently move it.
			* @param alarm - the alarm to edit.
			*/
			const startEdit = (0, react.useCallback)((alarm) => {
				const local = browserZone();
				setEditingId(alarm.id);
				setSelectedDay(formatDate(alarm.at, local));
				setTime(formatHm(alarm.at, local));
				setKeyword(alarm.keyword);
				setNote(alarm.note ?? "");
				setSessionId(alarm.sessionId);
				setError("");
			}, []);
			/** Leave edit mode without touching the alarm. */
			const cancelEdit = (0, react.useCallback)(() => {
				setEditingId(null);
				setKeyword("");
				setNote("");
				setError("");
			}, []);
			const submit = (0, react.useCallback)(async () => {
				if (keyword.trim() === "") {
					setError("请填写关键词：唤醒消息用它开头");
					return;
				}
				if (sessionId === "") {
					setError("请选择要唤醒的对话");
					return;
				}
				setBusy(true);
				try {
					const at = instantFromLocal(selectedDay, time);
					const zone = browserZone();
					const targetTitle = state === null ? void 0 : state.sessions.find((row) => row.id === sessionId)?.title ?? void 0;
					if (editingId === null) await call("/alarms", {
						at,
						timeZone: zone,
						keyword: keyword.trim(),
						note: note.trim() === "" ? void 0 : note.trim(),
						label: void 0,
						sessionId,
						sessionTitle: targetTitle,
						origin: "user"
					});
					else await call("/alarms/update", {
						id: editingId,
						at,
						timeZone: zone,
						keyword: keyword.trim(),
						note: note.trim(),
						sessionId,
						sessionTitle: targetTitle ?? ""
					});
					setEditingId(null);
					setKeyword("");
					setNote("");
					setError("");
					await refresh();
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
				} finally {
					setBusy(false);
				}
			}, [
				keyword,
				note,
				selectedDay,
				sessionId,
				state,
				time,
				refresh,
				editingId
			]);
			const act = (0, react.useCallback)(async (path, id) => {
				try {
					await call(path, { id });
					await refresh();
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
				}
			}, [refresh]);
			(0, react.useEffect)(() => {
				if (!open) return void 0;
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [open]);
			const pendingCount = alarms.filter((alarm) => alarm.status === "pending").length;
			return react.default.createElement(react.default.Fragment, null, !open ? null : react.default.createElement("div", {
				className: clock_module_css_default.panel,
				role: "dialog",
				"aria-modal": "true",
				"aria-label": "时钟与日历"
			}, react.default.createElement("div", { className: clock_module_css_default.header }, react.default.createElement("span", { className: clock_module_css_default.title }, pendingCount > 0 ? "时钟与日历 · " + String(pendingCount) + " 个待触发" : "时钟与日历"), react.default.createElement("span", { className: clock_module_css_default.headerSpacer }), react.default.createElement("button", {
				className: clock_module_css_default.iconButton,
				title: "刷新",
				onClick: () => {
					refresh();
				}
			}, "⟳"), react.default.createElement("button", {
				className: clock_module_css_default.iconButton,
				onClick: () => setOpen(false),
				title: "关闭"
			}, "✕")), react.default.createElement("div", { className: clock_module_css_default.body }, react.default.createElement("div", { className: clock_module_css_default.clock }, react.default.createElement("div", { className: clock_module_css_default.clockTime }, formatTime(now, zone)), react.default.createElement("div", { className: clock_module_css_default.clockMeta }, react.default.createElement("div", { className: clock_module_css_default.clockDate }, formatDate(now, zone)), react.default.createElement("div", { className: clock_module_css_default.clockZone }, zone)), react.default.createElement("div", { className: clock_module_css_default.nextAlarm }, react.default.createElement("div", { className: clock_module_css_default.nextLabel }, "下一个唤醒"), nextPending === null ? react.default.createElement("div", { className: clock_module_css_default.nextValueIdle }, "无") : react.default.createElement("div", { className: clock_module_css_default.nextValue }, countdownText(nextPending.at - now)))), react.default.createElement("div", { className: clock_module_css_default.calendar }, react.default.createElement("div", { className: clock_module_css_default.calendarBar }, react.default.createElement("button", {
				className: clock_module_css_default.iconButton,
				onClick: () => setCursor((c) => c.month === 0 ? {
					year: c.year - 1,
					month: 11
				} : {
					year: c.year,
					month: c.month - 1
				})
			}, "‹"), react.default.createElement("span", { className: clock_module_css_default.monthLabel }, cursor.year + " 年 " + String(cursor.month + 1) + " 月"), react.default.createElement("button", {
				className: clock_module_css_default.iconButton,
				onClick: () => setCursor((c) => c.month === 11 ? {
					year: c.year + 1,
					month: 0
				} : {
					year: c.year,
					month: c.month + 1
				})
			}, "›"), react.default.createElement("span", { className: clock_module_css_default.headerSpacer }), react.default.createElement("button", {
				className: clock_module_css_default.iconButton,
				title: "回到今天",
				onClick: () => {
					const today = /* @__PURE__ */ new Date();
					setCursor({
						year: today.getFullYear(),
						month: today.getMonth()
					});
					setSelectedDay(todayKey());
				}
			}, "今天")), react.default.createElement("div", { className: clock_module_css_default.weekdays }, [
				"一",
				"二",
				"三",
				"四",
				"五",
				"六",
				"日"
			].map((label) => react.default.createElement("div", { key: label }, label))), react.default.createElement("div", { className: clock_module_css_default.days }, grid.map((cell) => {
				const marks = byDay.get(cell.key) ?? [];
				const fired = marks.length > 0 && marks.every((alarm) => alarm.status !== "pending");
				const dayClass = clock_module_css_default.day + (cell.inMonth ? "" : " " + clock_module_css_default.dayOutside) + (cell.isToday ? " " + clock_module_css_default.dayToday : "") + (cell.key === selectedDay ? " " + clock_module_css_default.daySelected : "");
				return react.default.createElement("button", {
					key: cell.key,
					className: dayClass,
					onClick: () => setSelectedDay(cell.key),
					title: marks.length === 0 ? cell.key : cell.key + " · " + String(marks.length) + " 个唤醒"
				}, react.default.createElement("span", null, String(cell.day)), marks.length > 0 ? react.default.createElement("span", { className: clock_module_css_default.dot + (fired ? " " + clock_module_css_default.dotFired : "") }) : null);
			}))), react.default.createElement("div", { className: clock_module_css_default.alarmPanel }, react.default.createElement("div", { className: clock_module_css_default.column }, react.default.createElement("div", { className: clock_module_css_default.columnHead }, react.default.createElement("span", null, "待触发"), react.default.createElement("span", null, String(pendingAlarms.length))), react.default.createElement("div", { className: clock_module_css_default.columnBody }, pendingAlarms.length === 0 ? react.default.createElement("div", { className: clock_module_css_default.empty }, "没有待触发的唤醒") : pendingAlarms.map((alarm) => react.default.createElement(AlarmRow, {
				key: alarm.id,
				alarm,
				now,
				onFire: (id) => {
					act("/alarms/fire", id);
				},
				onCancel: (id) => {
					act("/alarms/cancel", id);
				},
				onForget: (id) => {
					act("/alarms/forget", id);
				},
				onEdit: startEdit
			})))), react.default.createElement("div", { className: clock_module_css_default.column }, react.default.createElement("div", { className: clock_module_css_default.columnHead }, react.default.createElement("span", null, "已结束"), react.default.createElement("span", null, String(settledAlarms.length))), react.default.createElement("div", { className: clock_module_css_default.columnBody }, settledAlarms.length === 0 ? react.default.createElement("div", { className: clock_module_css_default.empty }, "还没有触发过的唤醒") : settledAlarms.map((alarm) => react.default.createElement(AlarmRow, {
				key: alarm.id,
				alarm,
				now,
				onFire: (id) => {
					act("/alarms/fire", id);
				},
				onCancel: (id) => {
					act("/alarms/cancel", id);
				},
				onForget: (id) => {
					act("/alarms/forget", id);
				},
				onEdit: startEdit
			}))))), react.default.createElement("div", { className: clock_module_css_default.form }, editingId === null ? null : react.default.createElement("div", { className: clock_module_css_default.editingBanner }, "正在编辑待触发日程 · 保存后重新计算触发时间"), react.default.createElement("div", { className: clock_module_css_default.field }, react.default.createElement("span", { className: clock_module_css_default.fieldLabel }, "唤醒日期与时间"), react.default.createElement("div", { className: clock_module_css_default.fieldRow }, react.default.createElement("input", {
				className: clock_module_css_default.input + " " + clock_module_css_default.inputDate,
				type: "date",
				value: selectedDay,
				onChange: (event) => setSelectedDay(event.target.value)
			}), react.default.createElement("input", {
				className: clock_module_css_default.input + " " + clock_module_css_default.inputTimeFlex,
				type: "time",
				value: time,
				onChange: (event) => setTime(event.target.value)
			}))), react.default.createElement("div", { className: clock_module_css_default.field }, react.default.createElement("span", { className: clock_module_css_default.fieldLabel }, "唤醒哪个对话"), react.default.createElement("select", {
				className: clock_module_css_default.input,
				value: sessionId,
				onChange: (event) => setSessionId(event.target.value)
			}, react.default.createElement("option", { value: "" }, "— 请选择一个对话 —"), (state === null ? [] : state.sessions).map((row) => react.default.createElement("option", {
				key: row.id,
				value: row.id
			}, (row.cold ? "（未打开，到时会被唤醒）" : "") + (row.title === "" ? row.id : row.title))))), react.default.createElement("div", { className: clock_module_css_default.field }, react.default.createElement("span", { className: clock_module_css_default.fieldLabel }, "关键词（唤醒消息用它开头）"), react.default.createElement("input", {
				className: clock_module_css_default.input,
				placeholder: "例如：继续迁移",
				value: keyword,
				onChange: (event) => setKeyword(event.target.value)
			})), react.default.createElement("div", { className: clock_module_css_default.field }, react.default.createElement("span", { className: clock_module_css_default.fieldLabel }, "唤醒内容（可选，被唤醒的对话会读到）"), react.default.createElement("input", {
				className: clock_module_css_default.input,
				placeholder: "例如：检查构建是否结束",
				value: note,
				onChange: (event) => setNote(event.target.value)
			})), react.default.createElement("button", {
				className: clock_module_css_default.button + " " + clock_module_css_default.buttonBlock,
				disabled: busy,
				onClick: () => {
					submit();
				}
			}, busy ? "保存中…" : editingId === null ? "创建唤醒" : "保存修改"), editingId === null ? null : react.default.createElement("button", {
				className: clock_module_css_default.smallButton + " " + clock_module_css_default.buttonBlock,
				style: { marginTop: "6px" },
				onClick: cancelEdit
			}, "取消编辑"), state !== null && state.scheduler.systemScheduler ? react.default.createElement("div", { className: clock_module_css_default.hint }, "系统计划任务：" + (state.scheduler.systemTaskArmedFor === null ? "未挂载" : formatDate(state.scheduler.systemTaskArmedFor, zone) + " " + formatHm(state.scheduler.systemTaskArmedFor, zone))) : react.default.createElement("div", { className: clock_module_css_default.hint }, "系统计划任务不可用，仅使用进程内定时器"), error === "" ? null : react.default.createElement("div", { className: clock_module_css_default.error }, error)))));
		}
		//#endregion
		//#region src/client/index.tsx
		/** The additive sidebar-foot seat this plugin fills. */
		const SIDEBAR_SLOT = "sidebar.footer.action";
		/**
		* Client services this plugin needs.
		*
		* Declaring `slots` is what makes the sidebar seat reachable; without it the
		* plugin would simply not activate, and the panel would quietly stop existing.
		*/
		const inject = ["slots"];
		/**
		* Mount the panel and register the sidebar trigger.
		* @param ctx - the client plugin context.
		*/
		function apply(ctx) {
			report("apply:start");
			const mount = document.createElement("div");
			mount.dataset.dshClockRoot = "";
			document.body.append(mount);
			let root = null;
			try {
				root = (0, react_dom_client.createRoot)(mount);
				root.render(react.default.createElement(ClockApp));
				report("panel:mounted");
			} catch (error) {
				report("panel:failed " + String(error));
				mount.remove();
				throw new Error("[clock] mounting the calendar panel failed: " + String(error));
			}
			ctx.effect(() => () => {
				root?.unmount();
				mount.remove();
			}, "ui-clock: panel lifecycle");
			const slots = ctx.slots;
			if (slots === void 0 || typeof slots.inject !== "function" || typeof slots.register !== "function") {
				report("slot:unusable hasSlots=" + String(slots !== void 0));
				return;
			}
			let registered;
			try {
				ctx.effect(() => {
					const outer = slots.inject(SIDEBAR_SLOT, () => {
						try {
							registered = slots.register({
								name: SIDEBAR_SLOT,
								id: "clock-calendar",
								order: 20
							}, CalendarButton);
							report("slot:registered " + SIDEBAR_SLOT);
						} catch (error) {
							report("slot:register-threw " + String(error));
						}
						return registered;
					});
					return () => {
						outer?.();
						registered?.();
					};
				}, "ui-clock: sidebar action");
				report("slot:inject-accepted " + SIDEBAR_SLOT);
			} catch (error) {
				report("slot:inject-threw " + String(error));
			}
			window.setTimeout(() => {
				if (registered === void 0) report("slot:callback-never-fired " + SIDEBAR_SLOT);
			}, 4e3);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map