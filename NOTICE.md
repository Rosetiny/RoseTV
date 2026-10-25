# Attribution and licenses

RoseTV contains modified frontend and desktop application code from the original projects. Product naming changes do not change ownership of upstream contributions.

- Original frontend: LibreTV, LibreTV Team / LibreSpark, https://github.com/LibreSpark/LibreTV
- Desktop upstream: LibreTV-App, https://github.com/KeyRotate/LibreTV-App
- Desktop source metadata identifies bestZwei as an upstream author.
- The original Apache License 2.0 text and copyright statement are preserved verbatim in `source/LICENSE`.
- Bundled dependencies retain their own notices under `App/licenses/` and the applicable source/library files.
- The private Windows Python distribution and dependency license files are included in `runtime/python-runtime.zip`; provenance and hashes are listed in `runtime/manifest.json`.

The current local build modifies verified embedded frontend assets and uses an unchanged upstream native kernel. The original executable is retained locally under `backups/20261022-performance/`; the public repository supplies its compressed build base under `vendor/`. Both inputs are checked by SHA-256 before building.

RoseTV changes include the local adapter, bounded metadata caching, cancellation, continuous catalogue pagination, source matching, favorites, player tabs, window controls, and product styling. No ownership of third-party movie metadata or media is claimed.
