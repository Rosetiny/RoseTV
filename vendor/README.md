# Native build base

`rosetv-native-base.br` is the Brotli-compressed, unmodified upstream Windows executable used as the input for the verified local frontend build. It contains no RoseTV bridge token or user profile. It is a build dependency, not the RoseTV distribution executable.

Decompressed SHA-256:

```text
52980511d53d34cedb723afe2fec0a73f9bf615928f4baffc93612d58c821f86
```

Upstream: https://github.com/KeyRotate/LibreTV-App

Upstream names inside this unchanged third-party binary are retained. See the original license in `source/LICENSE` and the project `NOTICE.md`. The build validates the hash before modifying embedded frontend assets.
