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
export const SKILL_NAME = 'clock'

/** One line for routing decisions. */
export const SKILL_DESCRIPTION =
  'Schedule a wake-up: at a chosen instant a message carrying a keyword is delivered into a chosen conversation, including one that is closed. Use for reminders, for returning to slow work, and for resuming another conversation later.'

/** Longer guidance shown alongside the description by discovery consumers. */
export const SKILL_WHEN_TO_USE =
  'Use when something should happen at a set time rather than now: a reminder the user asked for, a slow job to check back on, or work that must resume in a different conversation.'

/** The markdown body the model reads when it loads the skill. */
export const SKILL_BODY: string = [
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
  "",
].join('\n')

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
