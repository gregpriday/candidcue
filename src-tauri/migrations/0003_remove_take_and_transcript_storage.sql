-- Take history and retained transcripts are gone (#217).
--
-- Takes stopped writing either (#214) and the retention setting left Settings
-- (#215), so these tables had no writer and no reader. What a pre-release build
-- may have left in them is real speech, though, and the retention sweep was the
-- only thing that enforced the window the presenter chose: with the sweep gone
-- and the rows kept, "1 day" would have quietly become "forever" for words
-- nobody could see or delete. So they go, rather than lie inert.
--
-- `sessions.transcript_retained` was the consent latch for the second table and
-- means nothing without it. Every session row itself survives.
--
-- Dropping a table only frees its pages; the words stay on disk until they are
-- overwritten. sqlx runs every migration inside a transaction, where VACUUM
-- cannot run, so `database::init` scrubs the file after this commits. The
-- verified pre-migration backup taken before this ran is deliberately left
-- whole: it is the rollback copy.

DROP TABLE session_transcript_items;
DROP TABLE session_takes;
ALTER TABLE sessions DROP COLUMN transcript_retained;
