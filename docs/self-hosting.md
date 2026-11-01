# Self-hosting: open DeepSeek Harness with Hodos from your phone

DeepSeek Harness (DSH) serves its chat as a web page, so a phone can use it like any other site once the machine that runs it is reachable. This guide sets that up on a computer or server you own. Nothing here publishes or uploads anything: the packages come from the npm registry, and the only outbound traffic is DSH's calls to your model provider.

Hodos adds two things for this: [`deploy/install.sh`](../deploy/install.sh) installs DSH and the Hodos bundles, and [`deploy/serve.sh`](../deploy/serve.sh) starts the web UI on a network address with the right trust settings. A Dockerfile and a compose file run both in a container.

## Read this first

**Whoever signs in can run commands on that machine.** The DSH chat has a shell, file and network tools, and it runs them as the user that started it. The sign-in link and the cookie it creates are the only protection, so treat them like an SSH key. A Hodos learning session hides those tools from the tutor, but the same browser can open an ordinary chat.

- Prefer a private network (a VPN) or TLS, and keep the port closed to the public internet.
- Run it as a user with nothing you mind losing, or in the container below, whose workspace is a separate volume.
- The printed address carries a one-time token. Anyone who sees that line, in a terminal or in `docker compose logs`, can sign in. Open it yourself first.

## How the phone reaches it

DSH listens on loopback by default. To change that it takes one concrete address (never "all addresses"), and it refuses API and app requests whose `Host` header is not that address, a loopback name, or one you named as trusted. `serve.sh` fills these in from the settings below. It also refuses to serve plain HTTP on a network address unless you say that is acceptable, because plain HTTP sends the session cookie unencrypted.

Pick one:

| Way | Settings | What protects the traffic |
|---|---|---|
| **A VPN** (WireGuard, Tailscale or similar) between the phone and the machine | `HODOS_HOST` = the machine's VPN address, `HODOS_ALLOW_PLAIN_HTTP=1`, `HODOS_PUBLIC_URL=http://<vpn address or name>:8787/` | The VPN encrypts it. Only devices on the VPN can reach the port |
| **TLS from a certificate** | `HODOS_TLS_CERT`, `HODOS_TLS_KEY`, `HODOS_PUBLIC_URL=https://<name>:8787/` | HTTPS, and the session cookie is marked `Secure`. The phone must trust the certificate: a certificate from a public authority works, a self-signed one does not unless you install it on the phone |
| **A reverse proxy that adds TLS** in front | `HODOS_PUBLIC_URL=https://<the proxy's address>/`, listen on an address only the proxy can reach | The proxy's HTTPS. It must pass WebSocket connections through (the chat uses one at `/api/remote.mux`) and must not be open to people who should not have a shell on this machine |
| **An SSH tunnel** from a laptop | `HODOS_LOCAL_ONLY=1`; `ssh -L 8787:127.0.0.1:8787 you@machine`; open the printed address with `127.0.0.1` | SSH. This is the plainest way when you only need a laptop |

I tested plain HTTP on a network address (what a VPN gives you, with the `HODOS_ALLOW_PLAIN_HTTP` opt-in) and TLS from a certificate, on one machine, with a made-up host name standing in for the phone's address (see [what was tested](#what-was-tested)). I did not test a particular VPN product, a reverse proxy, or SSH tunnelling; for a proxy I only checked that `serve.sh` accepts an `https://` public address in front of plain HTTP.

## On your own machine

You need Node.js 24.9 or later, pnpm 11 and npm, and a model key for DeepSeek Harness.

```sh
git clone https://github.com/AliSohani2082/Hodos.git
cd Hodos
deploy/install.sh                     # builds Hodos, installs DeepSeek Harness 0.2.1-rc.3, adds the bundles
export DEEPSEEK_API_KEY=...           # your model key; never stored by Hodos
HODOS_HOST=100.64.0.7 HODOS_ALLOW_PLAIN_HTTP=1 \
HODOS_PUBLIC_URL=http://100.64.0.7:8787/ \
  deploy/serve.sh
```

Replace `100.64.0.7` with the address the phone uses. `serve.sh` prints one line:

```
dsh web: http://100.64.0.7:8787/?token=…
```

Open that address in the phone's browser. It signs the phone in, removes the token from the address, and keeps a cookie for 30 days. The next time, open the address without the token.

`install.sh` takes `build` (Hodos and the Harness), `plugins` (add the bundles to the profile; safe to repeat) or `all` (the default). `HODOS_PLUGINS="chess code"` chooses which interface plugins to add (`none` adds only the learning sessions). On a machine where you already have DeepSeek Harness, set `HODOS_DSH_BIN` to its `dsh` and run `deploy/install.sh plugins`.

## In a container

```sh
cd deploy
cp .env.example .env        # then edit .env: DEEPSEEK_API_KEY, HODOS_PUBLIC_URL, how to publish the port
docker compose up -d --build
docker compose logs hodos | grep "dsh web:"
```

The image runs as an unprivileged user. Two volumes keep what must survive a rebuild: `/data` (the Harness home: settings, the sign-in secret, sessions, Hodos records) and `/workspace` (where the agent works). The compose file publishes the port on `127.0.0.1` only; set `HODOS_BIND` in `.env` to the address of your VPN interface, or put a proxy on this machine in front. At every start the container adds the Hodos bundles to the Harness profile, so a new image picks them up.

**I could not build or run this image here:** the environment I worked in has no Docker daemon. What I did run is every step the image runs, outside a container: `deploy/install.sh build` from a clean prefix, and `deploy/docker-entrypoint.sh` against an empty Harness home (it added the four bundles and served). `docker compose config` parses the compose file. The first `docker compose up --build` is the first real test of the Dockerfile; if it fails, the error will name a missing system package or a step above, and the fix is a line in `deploy/Dockerfile`.

## Settings

All are environment variables of `serve.sh` (in the container, of `.env`). All are optional.

| Variable | Default | Meaning |
|---|---|---|
| `DEEPSEEK_API_KEY` | none | The model key. Without it the chat has no model, unless you configured one in DSH's settings |
| `HODOS_PORT` | `8787` | Listen port |
| `HODOS_HOST` | this machine's first non-loopback IPv4 address | The one address to listen on. `0.0.0.0` is refused: DSH does not listen on all addresses |
| `HODOS_LOCAL_ONLY` | off | `1` listens on `127.0.0.1` only, and wins over `HODOS_HOST` |
| `HODOS_PUBLIC_URL` | none | The address the phone uses. The printed address is built on it and its host is trusted automatically. It must have no credentials, query or fragment |
| `HODOS_TRUSTED_HOSTS` | none | More names or addresses the phone may use, comma separated, as `host` or `host:port`. No wildcards |
| `HODOS_TLS_CERT`, `HODOS_TLS_KEY` | none | Serve HTTPS from a certificate chain and an unencrypted key (both, or neither). DSH does not renew or watch them: restart after a change |
| `HODOS_ALLOW_PLAIN_HTTP` | off | `1` accepts plain HTTP on a network address. Only for a VPN or another encrypted private network |
| `HODOS_WORKSPACE` | the current directory | The directory the agent works in |
| `HODOS_DSH_BIN` | the one `install.sh` installed | The `dsh` launcher |
| `DSH_HOME`, `DSH_PROFILE` | `~/.dsh`, `web` | The Harness home and profile |
| `DSH_PREFIX`, `DSH_VERSION` | `~/.local/share/hodos/dsh`, `0.2.1-rc.3` | Where `install.sh` puts DeepSeek Harness, and which version |
| `HODOS_PLUGINS` | `chess code math language` | Interface plugins `install.sh` adds |
| `HODOS_DRY_RUN` | off | `1` prints the `dsh` command and exits |

`serve.sh` refuses to start when plain HTTP would be served on a network address without `HODOS_ALLOW_PLAIN_HTTP=1`, a TLS certificate or an `https://` public address, and tells you which setting to choose. The Hodos settings (strictness, extraction budget, plugin directories) are the usual ones in the profile's `cordis.patch.yml`; see the [install guide](install.md#configure).

## Using it on a phone

DSH's own page is responsive. On a phone, the right sidebar fills the screen, so:

1. In the chat, say what you want to learn.
2. Tap **Open right sidebar**, then **Hodos learning**. The probe question, the plan map and later questions appear there.
3. To chat again, tap **Collapse right sidebar**.

On a phone-sized touch screen I checked the sign-in, choosing the workspace, starting a session, reading the probe question, and solving a chess position by tapping the squares (the server replied, the line finished, and the plan appeared). I did not check the Knowledge graph tab, the Python sandbox or practice sessions on a phone-sized screen; they use the same panel, but I have not looked.

## Keeping it safe

- **The model key.** Set it in the environment or `.env`, never in the image or the repository (`.env` is git-ignored and excluded from the build). DSH's documentation says its shell tool scrubs ambient credentials, and the end-to-end test confirms it: an `env` command run by the agent shows no key.
- **The sign-in.** The cookie lasts 30 days and is bound to the host name and port it was issued for. DSH has no logout: clearing the browser's cookie ends one browser, and deleting the owner credential record in `$DSH_HOME/.credentials.yaml` and restarting revokes every browser.
- **A new token at every start.** A restart prints a new link. Phones that already signed in keep working, because the cookie's secret is stored in the Harness home (per DSH's documentation; I did not test a restart).
- **Firewall.** `HODOS_BIND` and `HODOS_HOST` decide who can reach the port. Check from a device that should not reach it.
- **Updates.** Pull this repository and run `deploy/install.sh` again (or `docker compose up -d --build`). Back up `$DSH_HOME` (or the `/data` volume) first; it holds the learning records.

## What was tested

At commit time, on Linux x64 with DeepSeek Harness 0.2.1-rc.3 and Chromium emulating an iPhone 13, with a scripted model:

- `deploy/serve.sh` has a unit test for what it passes and refuses (`tests/integration/serve-script.test.ts`, 10 tests).
- `tests/e2e/selfhost.e2e.test.ts` (8 tests) runs `install.sh plugins`, then `serve.sh` on this machine's network address, and opens it from a touch browser by a host name that stands in for the phone's address. It checks that the printed address uses the public host and carries a token; that the API and the app answer 401 without a sign-in for the public name and the listening address, and 403 for any other host name; that the token signs in and leaves the address; that the agent's shell does not see the model key; that a learning session's first question shows; and that a chess position can be solved by touch. A second part serves HTTPS from a self-signed certificate and checks that the cookie is `Secure`, that plain HTTP to the TLS port fails and that other host names get 403.
- The same test passed against a Harness installed from scratch by `install.sh build`.

Not tested: Docker (no daemon here), a real phone, a real VPN or proxy, a restart with signed-in phones, DSH's terminal tab (npm 11 warned that five packages' install scripts were not run during `install.sh build`; the shell tool worked in the tests), macOS and Windows hosts, and a real model. The HTTPS test used `phone.localhost` for the host name, since the sandbox I developed in resets TLS connections to other made-up names.
