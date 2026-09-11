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
export const SKILL_NAME = 'clock'

/** One line for routing decisions. */
export const SKILL_DESCRIPTION =
  'Schedule a wake-up: at a chosen instant a message carrying a keyword is delivered into a chosen conversation, including one that is closed. Use for reminders, for returning to slow work, and for resuming another conversation later.'

/** Longer guidance shown alongside the description by discovery consumers. */
export const SKILL_WHEN_TO_USE =
  'Use when something should happen at a set time rather than now: a reminder the user asked for, a slow job to check back on, or work that must resume in a different conversation.'

/** The markdown body the model reads when it loads the skill. */
export const SKILL_BODY = "# clock — schedule a wake-up\n\n`clock` schedules a message to arrive in a conversation at a chosen instant. The message opens\nwith a keyword you choose, and it carries the scheduled time, the actual time, and the signed\ndrift, so the conversation that gets woken can tell \"on time\" from \"three hours late\".\n\n## When to use it\n\n- The user says \"remind me\", \"come back to this in an hour\", \"check the build at 17:00\".\n- You are starting something slow and know you should return to it.\n- Work should resume later in a **different** conversation, including one that is currently\n  closed. That is the case this exists for: the harness's own reminders are session-local and\n  cannot reach a conversation nobody has open.\n\nDo not use it as a notification channel. It delivers into a dsh conversation — not to a phone,\nnot by mail, not by push.\n\n## Actions\n\n| action | what it does |\n| --- | --- |\n| `now` | the current time, in a zone |\n| `set` | create a wake-up |\n| `list` | pending and recent alarms, with any delivery error |\n| `cancel` | cancel one by `id`, or `all: true` for every pending alarm of this conversation |\n\n## Setting one\n\nRelative delay, waking this conversation:\n\n    clock { action: \"set\", afterSeconds: 2700, keyword: \"check the build\",\n            note: \"the release job should be done by now\" }\n\nAbsolute instant, waking another conversation — including a closed one:\n\n    clock { action: \"set\", at: \"2026-09-11T09:30:00+08:00\", timeZone: \"Asia/Shanghai\",\n            keyword: \"standup\", sessionId: \"session-…\" }\n\n`sessionId` defaults to the calling conversation. A closed target is resumed before the message\nlands and **keeps its own id** — it is continued, not forked. Give `at` an explicit offset, or\npass `timeZone`, because an unqualified local time is a guess about which machine meant it.\n\n## What the woken conversation receives\n\n    ⏰ dsh-clock wake — keyword: check the build\n\n    scheduled  2026-09-11T09:30:00+08:00  [Asia/Shanghai]\n    now        2026-09-11T11:43:12+08:00  [Asia/Shanghai]\n    drift      +2h13m  OVERDUE\n    trigger    in-process timer\n\n    warning    OVERDUE by +2h13m: the host was not running at the scheduled instant …\n    note       This message was delivered by a timer, not typed by the user. …\n    detail     the release job should be done by now\n\n## Limits worth stating before you rely on one\n\n- **The host must be running.** Only the host can resume a conversation, so if dsh web is not up\n  at the scheduled instant the alarm is delivered as soon as it is, and says how late it is.\n  Nothing reaches the user while the machine is off.\n- **One-shot only.** There is no recurring rule; set another alarm if you need one.\n- A failed delivery is recorded on the alarm rather than lost — `list` shows the error.\n"

/** The skill registry, narrowed to the one method used. */
export interface SkillRegistryLike {
  register(skill: {
    name: string
    description: string
    whenToUse?: string
    source: string
    invocation?: { modelInvocable: boolean; userInvocable: boolean }
    content: string
  }): () => void
}

/**
 * Register the clock skill.
 * @param skills - the ctx.skills registry.
 * @returns the disposer removing the skill.
 */
export function registerSkill(skills: SkillRegistryLike): () => void {
  return skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    // 'bundled' is the source bucket for a skill a package ships, as opposed to
    // one found in a project or user skills directory. It is prompt-visible
    // metadata, not a precedence claim.
    source: 'bundled',
    invocation: { modelInvocable: true, userInvocable: true },
    content: SKILL_BODY,
  })
}
