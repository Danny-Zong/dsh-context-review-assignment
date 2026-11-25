# Context Review for DeepSeek Harness

Prose word count: 1065

A third-party plugin for the DeepSeek Harness desktop app. In a long conversation it finds the requirements the user gave earlier, shows each one with the user's original wording, asks when a reply may have dropped or contradicted one, and adds confirmed requirements to the next request. HCI Intelligent Interactive Systems, Assignment 2.

## Project status

Version 0.6.2, built for Harness `0.2.1-rc.2`.

**Works in Harness**

* **Start review** reads the whole conversation once. After that, every completed reply is checked automatically against the requirements found so far, even with the sidebar closed.
* **Itemized** and **Summary** views show the same requirements, each with its original wording and event number. Quotes that do not appear in the cited message are discarded.
* **Pop-up questions** appear when a reply may have omitted or contradicted a requirement:

  * **Still applies** adds the requirement to the next request.
  * **No longer applies** tells the assistant to stop following it.
  * **Review in sidebar** opens the evidence.
  * **Later** defers the question.
* **Temporary changes:** for a tentative change, the user keeps the earlier rule or confirms new wording and states in their own words when it applies, such as "for the next film".
* **Recovery** can be edited, previewed and cancelled before sending. It travels as a separate message, so the text box is untouched.
* **Request hold** (optional) pauses each request after Harness assembles it and shows which requirements are actually in it. The user can restore missing wording, send or cancel.
* **Reminders** (optional) ask for a check every N turns (1–99). **Settings** also turns finding pop-ups off.
* **Retry tools:** a tool-free retry preview, or a new Harness branch that resubmits the request with confirmed requirements.

**Simulated**

* **Controlled comparison** gives either view the same synthetic task with two withheld requirements. It records detection, misses, false alarms, restoration accuracy, time and a 1–7 effort rating, and makes no model calls.

**Not finished**

* The participant study has not been run.

**Known limitations**

* Each review raises at most one question.
* The plugin cannot tell whether a file the reply links actually exists.
* The middle of a very long reply is left out of the review.
* A restored requirement can still be ignored by the model.

## Technology stack

* **Plugin code:** JavaScript ES modules. The host part (`host.mjs`, `review.mjs`, `context.mjs`, `study.mjs`) runs in Harness's Cordis plugin system and reads the session log. The client (`client.js`) is React, drawn in Harness's chat header, sidebar and dialogs.
* **AI model:** reviews call the DeepSeek model the conversation already uses (deepseek-flash in my runs) through Harness's own model route. The model's JSON answer is treated as a proposal and checked in code.
* **Data:** no server. Requirements, decisions and holds stay on the device. Only review excerpts go to the model provider configured in Harness. Scope decisions are saved in the session log.
* **Tests:** the Node.js built-in test runner, and a Python 3 smoke test that drives a local Harness with an offline model adapter.
* **Undecided:** whether to batch several questions into one pop-up, and whether to check that linked files exist.

## Running or inspecting

1. In Harness, open **Plugins → Add plugin → Install third-party plugin**, select this folder (the one with `package.json`) and enable the plugin.
2. Fully quit and reopen Harness after any update, so the sidebar and host load the same version.
3. Open a conversation, click **Context Review** in its header, then **Start review**.

No API key is needed beyond the provider already set up in Harness.

Unit tests (Node.js 24):

```sh
node --test
```

Native smoke test (Windows, local Harness installation):

```sh
python test/harness-smoke.py C:/DeepSeekHarness
```

To inspect the code, start with `host.mjs` (events, queue and request hold) and `review.mjs` (model review and source checks).

## Development record

* **0.1:** extracted requirements from user messages, kept only verifiable quotes, and added confirmation before recovery.
* **0.2:** the two views looked alike, so Summary became a topic overview. Added editable recovery, reminders and retry previews. Tests covered both layouts and stale or duplicate recovery.
* **0.3:** opening the sidebar for every check was tedious, so review became automatic after each reply. Tests covered turn completion, cancellation and session isolation.
* **0.4:** added pop-ups that work with the sidebar closed, plus saved reminder settings.
* **0.5:** added the request hold, temporary changes, retry branches and the controlled comparison. The smoke test removed a requirement from a real assembled request, confirmed the hold caught it, restored it and checked the request that was sent.
* **0.5.2:** **No longer applies** only silenced the alert, but a retired rule can keep shaping replies. It now tells the assistant. Tests check that the notice reaches the request.
* **0.5.3:** reviews on a high-reasoning route ran out of output tokens, so the limit rose to 65,536 and errors name the stop reason. Each sidebar refresh also left a blank row in the chat, so the plugin now hides its own command rows.
* **0.6.0:** re-reading every message after each turn wasted time and tokens. One full review now sets a baseline and later reviews send only new messages plus known requirements.
* **0.6.1:** date ranges for temporary changes felt unnatural. Real changes apply "to this film" or "to the next few answers", so the user now describes the condition in their own words.
* **0.6.2:** in the film run, a reply's closing verdict and file link fell beyond the first 12,000 characters, causing a false alert. Reviews now keep the start and end of long replies.
* **Film walkthrough (19 turns):** automatic review raised five omission or conflict alerts and two scope questions. Two restorations led Harness to write files it had linked but not created. One alert was false (fixed in 0.6.2), and one missing file went unflagged.

## Additional files

None. The report is submitted separately. No ZIP or API key is needed.

## AI assistance

* Codex inspected the Harness interfaces, implemented the plugin (up to version 0.5.1) and built the original synthetic test case, before the real long-conversation run.
* Claude Code later fixed the bugs I found (versions 0.5.2–0.6.2), drew the system diagram from the implementation, made the storyboards from my descriptions and screenshots, and helped revise my report  for better English expression.
* I investigated the feasibility of the research and development direction, designed and planned the plugin's form, functions, and operation, chose specifically which changes to make, ran version test in Harness, write the report, and checked the report against the code, the session log and my Assignment 1 references.

