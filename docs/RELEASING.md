# Releasing

## Steps

1. Update `CHANGELOG.md` — move entries into a new `## X.Y.Z - YYYY-MM-DD` section
2. Bump `version` in `package.json`
3. Build and test:
   ```bash
   make build
   make test
   ```
4. Commit, tag, and push:
   ```bash
   git commit -am "vX.Y.Z"
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin v2.0 --tags
   ```
5. Install locally:
   ```bash
   make install
   ```

## Post-rebuild

After every rebuild, re-grant Automation permission by running a send command from a GUI terminal (not SSH). See README for details.
