# TV ntfy Alerts 1.0.0

Forward existing TradingView price alerts to your own ntfy server without webhooks,
polling or an open browser. Includes cookie setup, automatic reconnection,
persistent deduplication, connection notifications and safe diagnostic logs.

## Images

`ghcr.io/snailboob/tvntfyalerts:1.0.0` selects the correct architecture automatically:

- **linux/amd64**: Intel/AMD Synology and other x86-64 Docker hosts.
- **linux/arm64**: Raspberry Pi running a **64-bit OS**, and other ARM64 Docker hosts.

32-bit Raspberry Pi OS is not supported by these images.

For offline installation, download the matching `.tar.gz`, extract the `.tar`
and import it in Synology Container Manager, or use `docker load -i FILE.tar.gz`.
Checksums are provided in `SHA256SUMS`. Image archives contain no saved cookies
or deployment tokens. Follow the README for setup and persistent volumes.

If ntfy already runs on the same NAS, use `compose.existing-ntfy.yml` to join
its existing network. No change to the ntfy container is required.

## Verification and limitations

Both architectures are built and smoke-tested on native GitHub runners before
publication. Builds run automated protocol, delivery, diagnostics and settings
tests. Smoke tests cover non-root startup, static assets, startup notification
delivery, and persistence after recreating the container.

Live alert forwarding was verified on an Intel Synology. A physical Raspberry Pi
has not been tested. TradingView's private WebSocket is not an officially supported
integration and may change. Missed alerts are not replayed, and exactly-once
delivery across a crash is not guaranteed. See the README for details.
