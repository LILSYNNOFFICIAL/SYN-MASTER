SYN-MASTER VST Companion for Windows (x64)
===========================================

Lets the SYN-MASTER web app (https://syn-master.ai.studio/) use the VST3
plugins installed on this PC. Plugin choice, chain order and controls stay in
the web app; this companion only scans, hosts and runs the plugins locally.

What is in this zip
-------------------
  syn-plugin-host.exe     The companion. Run this one.
  syn-plugin-scanner.exe  Scans VST3 bundles in a separate process (started by the host).
  syn-plugin-worker.exe   Hosts each plugin in its own process so a crashing
                          plugin cannot take down the host (started by the host).
  THIRD_PARTY_NOTICES.md  Licences of bundled components.

Keep all three .exe files in the same folder.

Install and run
---------------
1. Unzip to a folder you own, e.g. %LOCALAPPDATA%\Programs\SYN-MASTER-Companion.
   (Avoid running it straight from inside the zip.)
2. Double-click syn-plugin-host.exe. A console window opens and prints the
   status, the ports and a pairing code that looks like SYN-XXXX-XXXX.
3. In the SYN-MASTER web app open Plugins & Host, enter the pairing code and
   click "Pair & Connect Host". Leave the console window open while you work;
   close it (or press Ctrl+C) to stop the companion.

Windows SmartScreen warning (unsigned build)
--------------------------------------------
This build is not code-signed yet, so Windows may show
"Windows protected your PC". To run it:
  click "More info" -> "Run anyway".
If the file was blocked after download you can also right-click the .exe ->
Properties -> tick "Unblock" -> OK. Only do this for a zip you downloaded from
the official GitHub Releases page of LILSYNNOFFICIAL/SYN-MASTER, and compare it
with the published .sha256 checksum if you want to be sure:
  certutil -hashfile SYN-MASTER-VST-Companion-<version>-win-x64.zip SHA256

Network and privacy
-------------------
The companion listens on the loopback interface only, never on your LAN:
  HTTP       127.0.0.1:47832
  WebSocket  127.0.0.1:47833
Only browser pages served from https://*.ai.studio (the published app),
https://*.run.app (AI Studio deployments) or localhost/127.0.0.1 (development)
are accepted, and every session
must pair with the one-time SYN-XXXX-XXXX code shown in the console. If
Windows Firewall asks, the companion does not need network access beyond this
PC; you can deny public/private network access.

Options (advanced):
  --port <n>            HTTP port (default 47832)
  --ws-port <n>         WebSocket port (default 47833)
  --data-dir <path>     Data folder (default %LOCALAPPDATA%\SYN MASTER)
  --allow-origin <url>  Allow an extra web origin (development only)

Plugin catalog and the pairing file live in %LOCALAPPDATA%\SYN MASTER.
Standard VST3 folders are scanned: C:\Program Files\Common Files\VST3 and
%LOCALAPPDATA%\Programs\Common\VST3.

Uninstall
---------
Close the companion and delete its folder. Optionally delete
%LOCALAPPDATA%\SYN MASTER to remove the plugin catalog.
