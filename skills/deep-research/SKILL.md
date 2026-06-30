---
name: deep-research
description: Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, and synthesize a cited report. Use when the user wants a deep, multi-source, fact-checked research report on any topic. BEFORE starting, check whether the question is specific enough to research directly; if it is underspecified (e.g. "what car to buy" with no budget/use-case/region), ask 2-3 clarifying questions first, then proceed with the refined question. Drives parallel sub-agents (the task tool) plus web_search and web_fetch through Scope → Search → Fetch → 3-vote adversarial Verify → Synthesize.
---

# Deep Research

You are the **orchestrator** of a fan-out / fact-check / synthesize research pipeline. You decompose a question, dispatch parallel sub-agents (via the `task` tool) that search and read the web (`web_search`, `web_fetch`), adversarially verify what they find, and then write a **cited** report. Be rigorous: a claim that cannot survive skeptical scrutiny does not belong in the report.

**The research question is the user's text that follows these instructions** (the final user message; if invoked as `/skill:deep-research <question>`, it is the text after the command).

## Tools you rely on
- `task` — spawns one or more **parallel** isolated sub-agents. Params: `agent` (persona: `task`, `oracle`, `librarian`, `reviewer`, `explore`, …), `tasks: [{ id, description, assignment }]`, optional `context` prepended to every assignment. Each `assignment` must be **complete and self-contained**. Results are delivered back to you automatically as a follow-up — **wait for a batch to return before starting the next phase.** Sub-agents inherit `web_search` and `web_fetch`.
- `web_search` — provider-backed search (`query`, optional `recency`, `limit`). Returns `{title, url, snippet}`. **Requires `BRAVE_API_KEY`, `TAVILY_API_KEY`, or `KAGI_API_KEY`.** If web_search reports no provider is configured, stop and tell the user to set one of those keys.
- `web_fetch` — fetch a URL and get its readable page text (`url`, optional `maxChars`, `timeoutMs`).

## Budget / knobs (match these defaults)
- **5** search angles · **~3** sources fetched per angle (≈ **15** total, the fetch budget) · verify the top **25** claims · **3** adversarial votes per claim · a claim is **killed if ≥2 of 3** verifiers refute it.

## Entry gate
Before Phase 0: if the question is underspecified (missing scope, constraints, region, time frame, use-case, etc.), **ask the user 2-3 targeted clarifying questions and stop.** Once you have a focused question, proceed and weave the answers in. If it is already specific, proceed directly.

---

## Phase 0 — Scope (you do this yourself)
Decompose the question into **5 distinct, complementary search angles** that together cover it. Pick angles that suit the domain. Examples:
- generic: broad/primary · academic/technical · recent news · contrarian/skeptical · practitioner/implementation
- medical: anatomy · common causes · serious differentials · authoritative refs · red flags
- tech: state-of-art · benchmarks · limitations · industry adoption · cost/tradeoffs

For each angle produce `{ label, query, rationale }`. Make queries specific enough to surface high-signal results; avoid redundancy across angles.

## Phase 1+2 — Search & Fetch (5 parallel gatherer sub-agents)
Call `task` **once** with `agent: "task"` and **5 tasks** (one per angle), `context` = the original research question. Each task's `assignment`:

> ## Web Researcher — angle: «LABEL»
> Research question: "«QUESTION»"
> Your angle: **«LABEL»** — «RATIONALE». Search query: `«QUERY»`
>
> 1. Run `web_search` with the query (refine if the first results are weak). Rank results by relevance to the ORIGINAL question, not just the query; skip obvious SEO spam / content farms.
> 2. `web_fetch` the **top 2-3 most relevant** URLs (no more — the global fetch budget is ~15 across all angles).
> 3. From each fetched page, assess **source quality** (`primary` research/institution · `secondary` reporting · `blog`/opinion · `forum` · `unreliable`) and extract **2-5 FALSIFIABLE claims** that bear on the research question. Each claim must be a concrete, checkable statement (not a vague generality), include a **direct quote** from the page as support, and be rated **central / supporting / tangential**. Note the publish date if present. If a fetch fails or the page is irrelevant/paywalled, skip it.
> 4. Return a compact list. For every claim give: `claim`, `quote`, `importance`, plus its `sourceUrl`, `sourceTitle`, and `sourceQuality`. If you found nothing usable, say so explicitly.

When all 5 return, **assemble + dedupe**: drop duplicate sources (normalize URLs: lowercase, strip `www.` and trailing `/`), and merge claims that are clearly the same. Keep each claim tagged with its source url + quality.

**Rank the claims** by importance (`central` > `supporting` > `tangential`), breaking ties by source quality (`primary` > `secondary` > `blog` > `forum` > `unreliable`). Keep the **top 25**. If zero usable claims survive, report that the research was inconclusive and stop.

## Phase 3 — Verify (3 independent adversarial sub-agents)
Number the ranked claims `[0..N-1]`. Call `task` with `agent: "oracle"` and **3 tasks** (`verifier-1/2/3`) — three **independent** skeptics, each adjudicating **all** claims. Each assignment:

> ## Adversarial Claim Verifier
> Be SKEPTICAL. Your job is to **try to refute** each claim. Research question: "«QUESTION»".
> Below are «N» numbered claims, each with its source and supporting quote. For EACH claim, decide `refuted: true/false` and give specific `evidence` and a `confidence` (high/medium/low). For every claim run this checklist:
> 1. Is the claim actually supported by its quote, or an overreach/misread?
> 2. `web_search` for **contradicting** evidence — does any credible source dispute or heavily qualify it?
> 3. Is the source quality sufficient for the claim's strength? (extraordinary claims need primary sources)
> 4. Is the claim outdated? (old claims about fast-moving fields are suspect — check dates)
> 5. Is it marketing / a press release / a cherry-picked benchmark / forum speculation?
>
> **refuted=true** if: unsupported by the quote / contradicted / low-quality source for a strong claim / outdated / marketing fluff. **refuted=false ONLY if** the claim is well-supported, current, and the source quality matches its strength. **Default to refuted=true when uncertain.** Return one verdict per claim **by index**: `{ index, refuted, evidence, confidence }`.
>
> CLAIMS:
> [0] "«claim»" — source: «url» («quality») — quote: "«quote»"
> [1] …

**Tally per claim** (treat a missing verdict as an abstention): a claim **survives only if it got ≥2 valid verdicts AND fewer than 2 of them are `refuted`.** Everything else is killed. If nothing survives, report that adversarial verification refuted all claims (research inconclusive) and stop.

## Phase 4 — Synthesize (you do this yourself)
From the surviving claims:
1. Merge claims that say the same thing; combine their sources.
2. Group related claims into coherent **findings**, each directly answering the research question.
3. Assign each finding a **confidence**: `high` (multiple primary sources / unanimous votes), `medium` (secondary sources or split votes), `low` (single source or blog-quality).
4. Write a **3-5 sentence executive summary** that answers the question.
5. Note **caveats**: what's uncertain, which sources were weak, what is time-sensitive.
6. List **2-4 open questions** that emerged but weren't answered.

## Output format (render as Markdown)
```
# Deep Research: «question»

## Summary
«3-5 sentence executive answer»

## Findings
### 1. «finding» — confidence: high|medium|low
«evidence», citing sources inline as [domain](url).
- Sources: [title](url) (quality), …
### 2. …

## Caveats
«what's uncertain / weak / time-sensitive»

## Open questions
- «…»

## Refuted claims (for transparency)
- "«claim»" — killed «k»/3 refuted (source url)

## Sources consulted
- [title](url) — quality · angle
```

## Notes & faithfulness
- Cite a source for every finding; never present an unverified or refuted claim as fact.
- This recipe mirrors Claude Code's `deep-research` workflow (Scope → Search → Fetch → 3-vote adversarial Verify → Synthesize). The fidelity differences vs. the original: sub-agents are pi `task` processes (not schema-validated agents), so enforce the JSON-ish contracts yourself; and the 3 verifiers each adjudicate the full claim list rather than spawning 3 fresh agents per individual claim (same 3-vote / 2-refute gate, far fewer processes).
- Keep within the budget knobs above so a run stays bounded.
