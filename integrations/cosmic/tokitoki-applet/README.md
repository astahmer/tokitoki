# Tokitoki COSMIC applet

This is a minimal `libcosmic` applet scaffold. It calls the shared
`tokitoki widget-payload --cached --json` contract and keeps all Tokitoki data logic outside the
COSMIC UI process.

```sh
cargo run --release
```

The applet expects `tokitoki` to be available on `PATH`.
