# The harbor

The island's Windows service host. It keeps the island going when no window is open, when its person logs out, and
across reboots.

- **It runs as the island's own account,** a virtual service account (`NT SERVICE\<service name>`). That account has
  no password and can't sign in at the keyboard, and it isn't an administrator. Windows makes it with the service.
- **It keeps the core running.** It starts `node core/bin/island.ts`, and starts it again if it falls, waiting a little
  longer each time it falls quickly. Its output goes to `<home>/state/core.log`, and the harbor's own log is
  `<home>/state/harbor.log`.
- **It owns the island's front door,** `\\.\pipe\<pipe>`.
  - Node can't say who may open a pipe, so the harbor makes the door with its own security descriptor. The island's
    account and the people in `harbor.json` may read and write; the network is denied outright; nobody else gets in.
  - It refuses to start if something else already holds that pipe name.
  - It passes each connection through to the core's private door, where a ferry still has to present the island's
    token (`<home>/state/core.json`) in `island.hello`.
- **Stopping it stops the core cleanly:** the core logs `island.stop` and closes its door.

## Build

```sh
dotnet publish harbor -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o build/harbor
```

It's self-contained, so the machine doesn't need .NET installed to run it. It targets `net10.0-windows`.

## Install (once, as administrator)

```powershell
.\harbor\install.ps1 -IslandHome '<the island's home>' -Name "<the island's name>" [-ServiceName <name>] [-Pipe <door name>] [-Person DOMAIN\name] [-DryRun]
```

It does five things:

1. Copies harbor.exe, the core and `node.exe` into `<home>\app`.
2. Writes `<home>\app\harbor.json`.
3. Creates the service under the island's account. It starts automatically and restarts if it stops unexpectedly.
4. Gives the island's account and `-Person` (by default, whoever runs the script) full control of the home, and keeps
   SYSTEM. Nobody else gets access.
5. Starts the service and waits for the core.

Each island gets its own home, service and door. The door defaults to `island-<service name>`, so islands side by
side never collide, and the window finds each one's door in `<home>\state\harbor.json`. A layout for several islands:
`<drive>\Islands\<island name>`, one service per island.

`-DryRun` lists the steps and changes nothing. Running it again updates `<home>\app` and leaves everything else in the
home alone.

**Keys:** they're sealed to the account that set them. Keys set while the core ran in a console, as you, won't open
under the service. Set them again through a ferry once the service runs.

## Remove

```powershell
.\harbor\uninstall.ps1 -ServiceName PandoraDee [-IslandHome '<home>' -RemoveApp]
```

This stops the service and deletes it. The home (vault, chats, log, keys) is left exactly as it is.

## Run in a console

For development, it runs as whoever starts it:

```powershell
build\harbor\harbor.exe --config <harbor.json> --console     # Ctrl+C, or type: stop
```

## Tests

- `harbor/test/harbor.test.mjs` runs the real harbor.exe in a console. It checks:
  - the core starts;
  - the door's security descriptor;
  - a ferry comes in through the door, still needing the token;
  - a second harbor can't take the same door;
  - the core is restarted after it's killed;
  - the harbor stops cleanly.
- CI also installs it as a real service on a Windows runner, comes in through the door as the named person, and
  uninstalls it (`harbor/test/service-check.mjs`).
