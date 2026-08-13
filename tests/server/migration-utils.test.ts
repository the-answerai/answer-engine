import { describe, expect, it } from 'vitest';
import {
  downMigrationName,
  isDownMigration,
  isUpMigration,
  migrationVersion,
} from '../../scripts/migration-utils.js';

describe('migration file discovery', () => {
  it('keeps ordered up migrations separate from paired down migrations', () => {
    expect(isUpMigration('002_application_foundation.sql')).toBe(true);
    expect(isUpMigration('002_application_foundation.down.sql')).toBe(false);
    expect(isDownMigration('002_application_foundation.down.sql')).toBe(true);
    expect(downMigrationName('002_application_foundation.sql')).toBe(
      '002_application_foundation.down.sql',
    );
    expect(migrationVersion('002_application_foundation.sql')).toBe(2);
  });

  it('rejects malformed migration names', () => {
    expect(isUpMigration('2_application.sql')).toBe(false);
    expect(isDownMigration('002-application.down.sql')).toBe(false);
    expect(() => downMigrationName('README.md')).toThrow();
  });
});
