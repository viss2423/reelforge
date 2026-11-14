# Windows host scripts

Run ReelForge automatically on an always-on Windows PC or laptop and make it reachable from
phones on your home network.

## Install autostart

From an **elevated** PowerShell (Run as administrator) in the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1 -StartNow
```

What it does:

| Step         | Details                                                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launcher     | Writes `<data>\autostart\reelforge.cmd`, which sets `NODE_ENV=production`, `REELFORGE_DATA`, the ports and `MDNS`, runs `node src\index.ts` and restarts the server 10 s after a crash. A clean exit (shutdown, Ctrl+C) stops the loop. |
| Startup task | Scheduled Task **ReelForge** for your user, at logon, hidden (`conhost --headless`), no run-time limit, keeps running on battery, restarts on failure, one instance only.                                                               |
| Firewall     | Inbound TCP rules for the HTTP (8080) and HTTPS (8443) ports, **Private profile only**, in the rule group **ReelForge** (plus UDP 5353 with `-Mdns`).                                                                                   |
| Summary      | Prints the LAN URLs to open on your phone.                                                                                                                                                                                              |

Options:

| Parameter          | Default                                             | Meaning                                                             |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------- |
| `-DataDir <path>`  | `$env:REELFORGE_DATA` or `%USERPROFILE%\.reelforge` | Projects, media, exports, certificates, logs                        |
| `-HttpPort <n>`    | `8080`                                              | Pairing landing page + CA download; redirects everything else       |
| `-HttpsPort <n>`   | `8443`                                              | The app and API                                                     |
| `-NodePath <path>` | `node.exe` on `PATH`                                | Node.js 26+                                                         |
| `-RepoRoot <path>` | two levels above the script                         | Repository checkout to run                                          |
| `-Mdns`            | off                                                 | Answer `reelforge.local` over mDNS (`https://reelforge.local:8443`) |
| `-StartNow`        | off                                                 | Start the task immediately instead of at next logon                 |
| `-WhatIf`          |                                                     | Show what would change; works without elevation                     |

Logs go to `<data>\logs\server.log` (JSON lines; the previous 10 MB are kept in
`server.log.1`). Manage the task with `Start-ScheduledTask ReelForge` /
`Stop-ScheduledTask ReelForge` or Task Scheduler.

### First connection from a phone

1. Join the same Wi-Fi, open the `http://<pc-ip>:8080` URL the script printed.
2. Download and install the certificate (instructions for Android and iOS are on the page).
   This is a local CA generated on your PC; it lets the app use HTTPS, which is required to
   install it as an app.
3. Tap **Open ReelForge**, pair with the code shown on the PC, then "Add to Home Screen".

If the script reports a **Public** network, Windows ignores the Private-only firewall rules
there. For your home network, switch it to Private:

```powershell
Set-NetConnectionProfile -Name '<network name>' -NetworkCategory Private
```

The rules intentionally never open the ports on Public networks (cafés, airports).

### Away from home

Install [Tailscale](https://tailscale.com) on the PC and the phone. ReelForge detects it,
adds the Tailscale address and MagicDNS name to its certificate and shows them in Settings.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall-autostart.ps1
```

Removes the task, the launcher and the firewall rules. Your data stays in the data directory
unless you add `-RemoveData` (irreversible: deletes projects, media, exports and the CA).
