# Can a cheap model write compaction summaries?

When a session compacts, pi sends the older part of the conversation to the session's own model and asks it for a summary; the session then carries on from that summary. The `cheap-compaction` extension can hand that request to a cheaper model instead. This page records the evaluation that decided whether to turn it on for the team, and why the team default is off.

## Short answer

No, not with GPT-6 Luna. In a blind comparison, Sonnet 5.5's summary was the best of three on all 9 samples. Luna's summaries were mostly accurate but left out the details the session needed next, and on the largest sample both Luna summaries were judged unusable, so the agent would have to re-read the files the summary should have covered. A compaction on Sonnet cost $0.06 on average, so there is little to save and a lot to lose.

## What a compaction costs

Less than you might expect. Before summarizing, pi cuts each tool result to its first 2,000 characters, and file reads are most of a session's size. A 117K-token session sent a 20K-token summary request.

| Summarizer                          | Mean cost per compaction | Highest |
| ----------------------------------- | -----------------------: | ------: |
| Sonnet 5.5, high thinking           |                   $0.059 |  $0.100 |
| GPT-6 Luna (Copilot), low thinking  |                  $0.0015 |  $0.003 |
| GPT-6 Luna (Copilot), high thinking |                  $0.0016 |  $0.003 |

GPT-6.1 Sol has Sonnet 5.5's prices ($2 input, $10 output per million tokens), so a Sol compaction costs about the same as Sonnet's.

## How it was tested

1. **Sessions.** Five multi-turn sessions were generated with Sonnet 5.5 doing real work in scratch copies of [click](https://github.com/pallets/click), [ky](https://github.com/sindresorhus/ky) and this repo: a feature, a library change, extension work with tests, a read-heavy investigation of pi's source, and debugging a planted bug. A sixth was a real earlier session that had already compacted twice, which tests updating an earlier summary. They ranged from 37K to 117K tokens.
2. **Compactions.** Each session was compacted three ways through pi's RPC `compact` command, on copies of the session file: pi's own compaction with Sonnet 5.5 at high thinking, and the extension with Luna at low and at high thinking. Every run cut the session at the same point, so all three summarized the same messages. Three sessions were also compacted keeping only the last 4K tokens instead of 20K, to give samples that summarize more: 9 samples in all, summarizing 1K to 20K tokens.
3. **Judging.** For each sample, a Claude Opus 5.5 agent read the transcript as the summarizers saw it, the recent messages pi keeps, and the three summaries under random letters. It scored each from 1 to 5 on faithfulness, goal and constraints, progress state, specifics and continuation, gave an overall score out of 10, said whether each was acceptable in place of the best, and listed every error and omission.

## Results

| Summarizer       | Overall (of 10) | Faithfulness | Specifics | Continuation | Acceptable | Ranked first | Errors | Omissions |
| ---------------- | --------------: | -----------: | --------: | -----------: | ---------: | -----------: | -----: | --------: |
| Sonnet 5.5, high |             8.4 |          4.0 |       5.0 |          4.6 |        9/9 |          9/9 |     14 |        10 |
| GPT-6 Luna, low  |             6.3 |          4.7 |       3.1 |          3.8 |        7/9 |          0/9 |      5 |        39 |
| GPT-6 Luna, high |             6.1 |          4.7 |       3.1 |          3.7 |        7/9 |          0/9 |      5 |        40 |

Overall score per sample (✗: judged not acceptable in place of the best):

| Sample                       | Tokens summarized | Sonnet 5.5 | Luna, low | Luna, high |
| ---------------------------- | ----------------: | ---------: | --------: | ---------: |
| click feature                |              2.2K |          9 |         7 |          6 |
| click feature, keep 4K       |             20.1K |          8 |         5 |          6 |
| ky change                    |              5.8K |          7 |         6 |        5 ✗ |
| ky change, keep 4K           |             17.2K |          9 |         7 |          7 |
| budget extension work        |             20.3K |          8 |         6 |          6 |
| pi source investigation      |             20.5K |          8 |       4 ✗ |        4 ✗ |
| click debugging              |              1.3K |          9 |         8 |          7 |
| click debugging, keep 4K     |             16.9K |          9 |       6 ✗ |          7 |
| real session, 3rd compaction |             13.0K |          9 |         8 |          7 |

What separated them:

- **Luna drops specifics.** Its summaries were 28% to 65% of the length of Sonnet's. They kept the goal and the broad state but lost file paths, line numbers, test names, expected values and the results of investigations. On the pi source investigation, the judge found that both Luna summaries reduced a four-part explanation to function names, which "would force a full re-read" before the agent could write the document it was asked for.
- **Sonnet errs more, but mostly harmlessly.** Most of its 14 errors were hedged guesses (for example, naming the changelog `CHANGES.rst` "as a convention to check") or stale lines in the section that summarizes a turn split by the cut point. Luna's few errors were of the same kinds.
- **Thinking didn't help Luna.** High thinking scored no better than low and took up to 100 seconds instead of 10.

## Limits of this evaluation

- Nine samples from six sessions, each judged once by one model. The gap is consistent (Sonnet first every time), but small differences between the two Luna settings are noise.
- Sonnet 5.5 stood in for GPT-6.1 Sol, the team default, which wasn't available on the evaluator's Copilot plan. Sol's own summaries weren't tested.
- The largest summary request was 20K tokens. Hour-long Sol sessions can send more, and Luna is unlikely to do better on them.

## When it would still pay

The extension only switches models when the session's model costs more per input token than the summarizer. It earns its keep when the session runs on a much more expensive model than one that summarizes well: for example, a Claude Fable or Opus session summarized by Sonnet 5.5. That pairing wasn't evaluated here. To try it, see [Cheaper compaction](../README.md#cheaper-compaction) in the README.
