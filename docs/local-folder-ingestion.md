# Permissioned local-folder ingestion

Local folders are never background-scanned or inferred from the home directory.
The user or guiding agent must pass one exact root for every source:

```bash
ae folders add /Users/me/Documents/notes \
  --include '**/*.md' \
  --exclude 'private/**' \
  --max-file-bytes 5242880 \
  --max-total-bytes 104857600
```

Discovery uses `lstat`, deterministic traversal, and a bounded 8 KiB sample. It
records candidates plus hidden, hard-ignored, custom-ignored, unsupported,
binary, oversized, aggregate-limited, permission-denied, missing, and symlink
rows. Symlinks are never followed. Discovery does not read full document bytes,
create archives, or import content.

Open `/import`, choose **Local folder**, and verify the exact root, include and
exclude patterns, limits, type/count/byte estimates, and warnings. Approval is
bound to the channel-local owner-only manifest under
`$AE_HOME/data/folder-ingestion`. The CLI refuses a missing, out-of-channel,
tampered, or server-mismatched manifest.

After approval, each candidate is restatted. A changed, missing, or newly
appeared path is not read and receives an explained outcome. Unchanged bytes are
archived atomically below `$AE_HOME/raw-archive/folders/<source-id>`, verified by
SHA-256, decoded as UTF-8 from the archive snapshot, and imported with stable
folder/path identity and raw-manifest lineage. Progress advances only after the
synchronous content import succeeds.

Resume and refresh with:

```bash
ae folders resume --source <source-id>
ae folders refresh --source <source-id>
```

Refresh produces an added/changed/unchanged/missing/excluded preview and waits
for another approval. Cancellation is checked between files, so resume remains
idempotent.

Removal always requires a retention choice:

```bash
ae folders remove <source-id> --retention keep
ae folders remove <source-id> --retention delete
```

`keep` detaches the source while retaining imported memories and archives.
`delete` removes mapped memories and source-owned archives. Preparation,
completion, counts, retention, and failures are tenant-scoped audit records.
Direct `ae sync ... --source local_dir` is intentionally rejected; migrate that
configuration by selecting the root with `ae folders add`.
