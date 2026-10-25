# RoseTV Windows runtime

`python-runtime.zip` contains a private Windows x64 Python runtime and the application's dependencies. The root `RoseTV.exe` verifies its SHA-256 and extracts it into the ignored `runtime/python/` directory on first launch. No system Python, pip installation or developer toolchain is required to use the application.

- Python 3.13.17: https://www.python.org/downloads/release/python-31317/
- Embeddable distribution documentation: https://docs.python.org/3.13/using/windows.html#the-embeddable-package
- Original archive SHA-256 and exact wheel hashes: `manifest.json`.
- Reproduction script: `tools/package_runtime.py`.
- Python's `LICENSE.txt` and dependency notices are retained inside the archive.

The bundle contains no account data, bridge configuration, browser profiles, movie caches or personal interpreter paths. Keep it with the project when sharing a clean source checkout. Close RoseTV before updating files. If a future release changes the bundled Python version, extract that release into a new folder.
