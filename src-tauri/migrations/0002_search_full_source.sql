-- Library search covers the whole script, not only what is spoken (#254).
--
-- `plain_text` is the spoken text: it feeds the preview, and it stays indexed
-- because the spoken form is not always in the source literally
-- (`**Candid**Cue` is spoken `CandidCue`). `body` is the source as the editor
-- shows it, so a word in a heading, a `:::stage` or `:::silent` block, code,
-- image alt text or a comment finds the script too.
--
-- FTS5 cannot add a column, so the table is replaced. Existing rows are carried
-- across with `body` empty, which searches exactly as before, and every script
-- is marked stale so startup reconciliation re-derives its row from the
-- canonical file — the file is the authority for content, not this database.

ALTER TABLE script_search RENAME TO script_search_v1;

CREATE VIRTUAL TABLE script_search USING fts5(
    script_id UNINDEXED,
    title,
    plain_text,
    body,
    tokenize = 'unicode61'
);

INSERT INTO script_search (script_id, title, plain_text)
    SELECT script_id, title, plain_text FROM script_search_v1;

DROP TABLE script_search_v1;

UPDATE scripts SET last_compile_version = NULL;
