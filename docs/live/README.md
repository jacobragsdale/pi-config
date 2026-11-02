# pi-live

Stream a [pi](https://pi.dev) session to colleagues. You run `/live` in pi and send them the one line it prints. They paste it into any terminal, follow your session as it happens, and can suggest prompts. Nothing a guest types reaches the agent unless you accept it.

```
your pi ──wss──▶ relay (AKS) ◀──ssh── guests
```

Your pi stays on your machine and dials out to a relay. Guests connect to the relay over SSH, which draws your session for each of them with pi's own components at their terminal's size. Guests need nothing installed but `ssh`. For how the pieces fit and why, see [How pi-live works](design.md).

## Set up

`/live` comes with pi-config, so there is nothing more to install. You need pi 1.4.0 and a relay. To deploy one, see [Deploy the relay to AKS](deploy.md); to try pi-live first, [run a relay on your machine](#run-a-relay-on-your-machine).

Tell pi where the relay is, in `~/.pi/agent/live.json`:

```json
{ "url": "wss://pi-live.example.corp/host" }
```

Then restart pi, or run `/reload`. `PI_LIVE_URL` overrides the file for one shell.

## Stream a session

1. Run `/live` in any pi session. Pi copies the join command to your clipboard, and shows it in a card above the editor until someone joins:

   ```
   Live. Send this to whoever should join (copied):
     ssh h3kq7x2mvb5rf4tnw6ydacpe@pi-live-ssh.example.corp
   /live link shows it again · /live ends the stream
   ```

2. Send the line to whoever should join. The footer shows who has joined, for example `● live · alice, bob`, or `● live · alice, bob +3` once more than three have.
3. Work as usual. Guests see your prompts, the model's replies and thinking as they stream, tool calls with their output, and compaction summaries.
4. When a guest suggests a prompt, it waits in a card above your editor, with up to three shown and a count of the rest:

   ```
   alice  try the migration tests
   alt+s accepts alice's and runs it · alt+x rejects it
   ```

   - `alt+s` accepts the first waiting suggestion and sends it to the agent, which runs it now, or after the current turn if it is working. It goes to the model as written: a suggestion can't run `/` commands, skills or `!` commands. While pi is compacting, accept it once that's done.
   - `alt+x` rejects it.

   The guest sees each of their suggestions as queued, with how many wait ahead of it, then accepted or rejected.

5. Run `/live` again to end the stream. Guests are disconnected and the link stops working. Quitting pi ends the stream too.

The stream follows you through `/new`, `/resume`, `/fork` and `/tree`: guests switch to whatever session you are in. A guest who joins late sees the whole current branch.

Anyone with the link can join. Secrets that look like tokens, keys and passwords are masked before anything leaves your machine, but the masking can miss things. Don't go live in a session that shows secrets. See [What leaves your machine](#what-leaves-your-machine).

## Join a stream

Paste the line you were sent:

```bash
ssh h3kq7x2mvb5rf4tnw6ydacpe@pi-live-ssh.example.corp
```

The first time, ssh asks whether to trust the relay's host key. Type `yes`. The key's fingerprint is in the relay's log, and should match what ssh shows. Then type your name and press Enter. The line above the editor confirms the name you joined as; from then on, what you type goes to the host as a suggestion.

The stream fills your terminal and looks like the host's pi, in the team's dark theme: the transcript with its cards above, then the editor and a one-line footer. The editor's bottom border shows the host's model, thinking level and context use, and its top border shows when the host's agent is working. The footer shows the host's directory and git branch, who is hosting and how many have joined, and the session's token use and cost. When the stream ends, or you leave, your terminal goes back to how it was, with one line saying how long you were in it.

Once you suggest a prompt, a card above the editor shows what became of it:

```
╭──────────────────────────────────────── your suggestions ─╮
│ ✓ accepted  try the migration tests                       │
│ ○ queued    add a test for expiry · next up               │
│ ○ queued    then update the docs · 1 ahead                │
╰───────────────────────────────────────────────────────────╯
```

The host answers suggestions in the order they arrived, from every guest. An accepted suggestion runs as the host's next prompt, and shows in the transcript like any other. The card keeps what's still queued, and the last one the host answered.

| Key                                    | Does                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| Enter                                  | Sends what you typed to the host as a suggestion. Three can be queued at once.         |
| PgUp, PgDn, or the mouse wheel         | Scrolls the transcript. New output keeps it at the bottom unless you have scrolled up. |
| `ctrl+end`                             | Jumps back to the latest message.                                                      |
| `ctrl+o`                               | Expands or collapses tool output.                                                      |
| `ctrl+c`, or `ctrl+d` on an empty line | Leaves the stream.                                                                     |

## Run a relay on your machine

To try pi-live without a cluster, run the relay locally and point pi at it. The relay needs Node.js 22.19 or later, and the repo's npm packages:

```bash
cd ~/pi-config && npm ci && npm run relay
```

The relay listens on port 8080 for pi and port 2222 for ssh, and creates `host_key` in the current directory on its first run. In another terminal:

```bash
PI_LIVE_URL=ws://localhost:8080/host pi
```

Run `/live`, then join from a third terminal with the command pi prints, for example `ssh -p 2222 h3kq7x2mvb5rf4tnw6ydacpe@localhost`.

## Commands

| Command        | Does                                                                |
| -------------- | ------------------------------------------------------------------- |
| `/live`        | Starts a stream, or ends the one that is running.                   |
| `/live link`   | Shows the join command again, and copies it.                        |
| `/live accept` | Same as `alt+s`: accepts the first waiting suggestion, and runs it. |
| `/live reject` | Same as `alt+x`: rejects the first waiting suggestion.              |

`/live` needs pi's interactive UI or an RPC client. It doesn't work in `pi -p`.

## Settings

The extension, on your machine:

| Setting                          | Default             | Meaning                                               |
| -------------------------------- | ------------------- | ----------------------------------------------------- |
| `url` in `~/.pi/agent/live.json` | none                | The relay's WebSocket address, ending in `/host`.     |
| `PI_LIVE_URL`                    | `url` from the file | Overrides `url`.                                      |
| `PI_LIVE_NAME`                   | your login name     | The name guests see, at most 64 characters.           |
| `PI_LIVE=0`                      | on                  | Turns the extension off: no `/live` and no shortcuts. |

The relay, all optional:

| Variable                | Default            | Meaning                                                                                          |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `PI_LIVE_HTTP_PORT`     | `8080`             | Port for hosts' WebSockets (`/host`) and the health check (`/healthz`).                          |
| `PI_LIVE_SSH_PORT`      | `2222`             | Port the SSH server listens on.                                                                  |
| `PI_LIVE_JOIN_HOST`     | `localhost`        | Host name in the join command.                                                                   |
| `PI_LIVE_JOIN_PORT`     | `PI_LIVE_SSH_PORT` | Port in the join command. `22` leaves `-p` out.                                                  |
| `PI_LIVE_HOST_KEY_FILE` | `host_key`         | The SSH host key. Created if missing; the container image expects it at `/etc/pi-live/host_key`. |

Limits: 50 streams per relay, 20 guests per stream (counting those still typing their name), 3 waiting suggestions per guest, 4,000 characters per suggestion (a longer one stays in the guest's editor), and 32 MiB per message from pi to the relay.

## What leaves your machine

Pi sends the relay what your terminal shows of the conversation:

- your prompts, including `!` commands and their output
- the model's replies and thinking
- tool calls and their results, such as file contents and command output
- compaction and branch summaries, and custom messages extensions display
- what pi's footer shows: your working directory, git branch, session name, token use and cost, context use, model and thinking level
- whether the agent is working

It never sends the system prompt, tool definitions, or custom messages extensions hide from the transcript. Images are replaced with `[image not shared]`. Every string passes through the same secret masking as `/submit-prompt` before it is sent. While the model or a tool is still writing, the last word waits until the next update, so a token that is only partly written never goes out.

The relay keeps a stream in memory only while you are connected, writes nothing to disk, and logs only names and counts.

## Develop

pi-live's tests run with pi-config's (see [Develop](../../README.md#develop)). They start real relays on free ports, connect guests over SSH, and drive pi 1.4.0 in RPC mode with a scripted provider and a throwaway agent directory, so they never touch `~/.pi/agent`.

The relay is an npm workspace with its own `relay/package.json`, so pi never sees its dependencies and the image installs only those. It draws with the pi version pinned there, and with `themes/shadcn-dark.json` and the `look` extension's code, which the image copies in, so a change to either needs a rebuilt image before guests see it. When you upgrade pi, bump `@earendil-works/pi-coding-agent` and `pi-tui` in `relay/package.json`, and `pi-coding-agent`, `pi-ai` and `pi-agent-core` in the root `package.json`, all to the same version. Then run `npm install` and the tests, and rebuild the relay image. If the relay's pi and the host's differ, `/live` warns that guests may see small differences.
