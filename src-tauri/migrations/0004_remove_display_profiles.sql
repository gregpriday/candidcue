-- Display profiles are gone (#232).
--
-- `0001_initial.sql` calls this table "kept and load-bearing: this is where
-- optical calibration lives durably". That stopped being true: calibrated rigs
-- live in the revisioned settings document (`settings::OpticalSettings`), and
-- single-window presentation removed the only caller that ever saved a
-- profile. The comment stays where it is — sqlx checksums every applied
-- migration, so editing 0001 would refuse every existing database — and this
-- is where it is corrected.
--
-- `scripts.selected_display_profile_id` was the per-script pointer into the
-- table. Nothing in the frontend ever set it, and it goes with the table.
--
-- Why the schema is edited rather than `scripts` rebuilt
-- ------------------------------------------------------
-- SQLite will not drop a column that a FOREIGN KEY names, and dropping only
-- the table leaves `scripts` referencing a parent that does not exist, after
-- which every INSERT into or DELETE from `scripts` fails. The usual remedy is
-- to rebuild the table, but sqlx runs each migration inside a transaction with
-- foreign keys ON, where `PRAGMA foreign_keys` cannot be changed: dropping the
-- old `scripts` would cascade away every revision and image reference, or be
-- refused outright by the sessions that RESTRICT it.
--
-- So the constraint is removed the way SQLite documents for exactly this case
-- (lang_altertable.html, "making other kinds of table schema changes"): edit
-- the stored CREATE TABLE text, then let ALTER TABLE drop the now-unreferenced
-- column, which rewrites the rows and bumps the schema cookie itself.
--
-- The text being edited is known exactly. It is 0001's own, stored verbatim,
-- and 0001 cannot have been applied with any other text. The FOREIGN KEY is
-- the last clause, so everything from it to the closing parenthesis goes. The
-- `instr` guard makes the edit a no-op on a definition without it, and the
-- DROP COLUMN that follows then succeeds for the same reason.
--
-- Nothing here holds anything private, so unlike 0003 there is no scrub.

PRAGMA writable_schema = ON;

UPDATE sqlite_schema
SET sql = rtrim(
        rtrim(
            substr(sql, 1, instr(sql, 'FOREIGN KEY (selected_display_profile_id)') - 1),
            ' ' || char(9) || char(10) || char(13)
        ),
        ','
    ) || char(10) || ')'
WHERE type = 'table'
  AND name = 'scripts'
  AND instr(sql, 'FOREIGN KEY (selected_display_profile_id)') > 0;

-- RESET, not OFF: it also reloads the schema, so the ALTER below parses the
-- edited definition rather than the one this connection cached.
PRAGMA writable_schema = RESET;

ALTER TABLE scripts DROP COLUMN selected_display_profile_id;
DROP TABLE display_profiles;
