# Pilot scoring spot-check

Reviewed manually against the final text, parser diagnostics, required block markers, and the gold task checklist. The ten records cover three models, both syntaxes, the exercise envelope (math S3), and block-heavy lessons with repairs and truncation (programming S5).

| Generation | Automatic verdict | Manual finding |
|---|---|---|
| Opus · math S3 · Markdoc | M1 valid; final valid; checklist 1; M4 0 | Agreed. The exercise has four choices, five hint levels, and three solution steps; the lesson cites the source chunks. |
| Opus · math S3 · directive | M1 valid; final valid; checklist 1; M4 0 | Agreed. The YAML exercise has four choices, five hints, and three steps; no required block was lost. |
| Sonnet · math S3 · Markdoc | M1 invalid; one repair; final valid; checklist 1; M4 0 | Agreed. First pass has unclosed/missing exercise fields; repair closes the envelope and supplies the required exercise data. |
| Sonnet · math S3 · directive | M1 valid; final valid; checklist 1; M4 0 | Agreed. Exercise envelope and required block set are present. |
| Haiku · math S3 · Markdoc | M1 valid; final valid; checklist 1; M4 0 | Agreed. Exercise contains four choices, five hints, and worked steps; no dropped markers. |
| Haiku · math S3 · directive | M1 invalid; one repair; final valid; checklist 1; M4 0 | Agreed. First pass has an unsupported attribute; repair removes it and keeps the required exercise blocks. |
| Opus · programming S5 · Markdoc | First response stopped at max tokens; final valid after three repairs; checklist 1; M4 0 | Agreed. A truncated first response cannot count as M1-valid even though it parses; final repaired lesson contains all required block types. |
| Opus · programming S5 · directive | Four responses stopped at max tokens; final invalid; checklist 1; M4 0 | Agreed. Final YAML body is cut off and reports `unclosed`/`bad-body`; the checklist blocks are present, so the checklist-presence metric is 1 while M2 correctly fails. |
| Sonnet · programming S5 · Markdoc | M1 invalid; one repair; final valid; checklist 1; M4 0 | Agreed. First pass has a bad value; repair clears diagnostics and preserves required block types. |
| Sonnet · programming S5 · directive | M1 invalid; one repair; final valid; checklist 1; M4 0 | Agreed. First pass has a bad value; repair clears diagnostics and preserves required block types. |

All ten manual checks agreed with M1/M2, repair count, checklist presence, and silent-drop scoring. This is a limited scoring sanity check, not a blind quality comparison; no Q1 judge or Q2 human preference test was run.
