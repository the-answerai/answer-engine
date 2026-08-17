import {
  loadReleaseManifestTemplate,
  verifyReleaseManifest,
  type ReleaseManifest,
} from '../release.js';

export const TEST_SOURCE_COMMIT = '1'.repeat(40);
export const TEST_RUNTIME_IMAGE = `ghcr.io/the-answerai/answer-engine@sha256:${'2'.repeat(64)}`;

export function releaseFixture(): ReleaseManifest {
  const template = loadReleaseManifestTemplate();
  return verifyReleaseManifest({
    ...template,
    sourceCommit: TEST_SOURCE_COMMIT,
    images: { ...template.images, answerEngine: TEST_RUNTIME_IMAGE },
  });
}
