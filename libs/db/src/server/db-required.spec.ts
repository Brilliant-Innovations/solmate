import { databaseUrlFromEnv } from './sql.js';

/**
 * A guard against integration coverage disappearing silently (2026-09-10).
 *
 * Every integration spec in this package is `describe.skipIf(!databaseUrlFromEnv())`. That is right
 * for a developer without the local stack running, and wrong for CI: if the URL is ever absent —
 * renamed variable, changed port, a job edited without noticing what depended on it — every
 * integration spec skips, vitest exits 0, and the job reports green having asserted nothing.
 *
 * That is the same shape as the defects this repository has been finding all week: a check that
 * reports success on an empty set. The difference is that this one would report success about *the
 * checks themselves*, which is why it gets its own guard rather than a comment.
 *
 * CI sets `REQUIRE_DB_TESTS=1` in the job that provides the database. Locally it is unset and this
 * passes trivially, which is the intended asymmetry.
 */
describe('integration coverage actually ran', () => {
  it('a run that declares it needs the database has one', () => {
    if (process.env['REQUIRE_DB_TESTS'] !== '1') return;
    expect(
      databaseUrlFromEnv(),
      'REQUIRE_DB_TESTS=1 but neither SUPABASE_DB_URL nor DATABASE_URL is set: every integration spec in this package would have skipped and this job would have reported green',
    ).toBeTruthy();
  });
});
