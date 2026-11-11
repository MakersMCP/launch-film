"use strict";
// A session bus of the tests' own with a stand-in for the desktop's portal
// on it, for the tests that hold Chrome to handing an address such as
// mailto: to no program of the machine. On a Linux desktop Chrome hands such
// an address to the portal (org.freedesktop.portal.OpenURI) over the session
// bus, and the portal opens the user's mail program: a test that reached the
// user's own bus would open it. This bus starts no service of its own, and
// the stand-in opens nothing: it takes the portal's names, writes down each
// call it gets and answers it with an error.
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { tmp, busPath } = require("./tmp");

const PORTAL = `import sys
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib
conn = Gio.DBusConnection.new_for_address_sync(sys.argv[1], Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
def calls(connection, message, incoming):
    if incoming and message.get_message_type() == Gio.DBusMessageType.METHOD_CALL and message.get_destination() != "org.freedesktop.DBus":
        print("CALL", message.get_interface(), message.get_member(), message.get_body(), flush=True)
        connection.send_message(message.new_method_error_literal("org.freedesktop.DBus.Error.NotSupported", "stand-in portal"), Gio.DBusSendMessageFlags.NONE)
        return None
    return message
conn.add_filter(calls)
for name in ("org.freedesktop.portal.Desktop", "org.freedesktop.FileManager1"):
    conn.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", GLib.Variant("(su)", (name, 4)), None, Gio.DBusCallFlags.NONE, -1, None)
print("owned", flush=True)
GLib.MainLoop().run()
`;

// Why there can be no such bus here, or "".
function noBus() {
  if (process.platform !== "linux") return "the desktop's portal is Linux's";
  if (spawnSync("dbus-daemon", ["--version"], { stdio: "ignore" }).status !== 0) return "no dbus-daemon to make a bus with";
  const python = spawnSync("python3", ["-I", "-c", "import gi; gi.require_version('Gio', '2.0'); from gi.repository import Gio"], { stdio: "ignore" });
  return python.status !== 0 ? "no Python with Gio for the stand-in portal" : "";
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Starts the bus and the stand-in, which end with the test: { address,
// calls() }, calls() giving the calls the portal has had so far. A call made
// here first shows that the bus works and the stand-in writes down what it
// is asked to open.
async function privateBus(t) {
  const dir = tmp("bus-");
  const socket = path.join(dir, "bus");
  fs.writeFileSync(path.join(dir, "bus.conf"), `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:path=${socket}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>
`);
  fs.writeFileSync(path.join(dir, "portal.py"), PORTAL);
  const ended = (child) => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve)));
  const daemon = spawn("dbus-daemon", [`--config-file=${path.join(dir, "bus.conf")}`, "--nofork", "--nopidfile"], { stdio: "ignore" });
  let portal = null;
  t.after(async () => {
    for (const child of [portal, daemon].filter(Boolean)) {
      child.kill();
      await ended(child);
    }
  });
  for (let waited = 0; waited < 10_000 && !fs.existsSync(socket); waited += 50) await wait(50);
  const address = `unix:path=${busPath(socket)}`;
  portal = spawn("python3", ["-I", path.join(dir, "portal.py"), address], { stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } });
  let said = "";
  portal.stdout.on("data", (chunk) => (said += chunk));
  for (let waited = 0; waited < 20_000 && !said.includes("owned"); waited += 50) await wait(50);
  if (!said.includes("owned")) throw new Error("the stand-in portal did not take its names");
  const calls = () => said.split("\n").filter((line) => line.startsWith("CALL "));
  spawnSync("python3", ["-I", "-c", "import sys, gi; gi.require_version('Gio', '2.0'); from gi.repository import Gio, GLib; c = Gio.DBusConnection.new_for_address_sync(sys.argv[1], Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None); c.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.OpenURI', 'OpenURI', GLib.Variant('(ssa{sv})', ('', 'mailto:control@acme.example', {})), None, Gio.DBusCallFlags.NONE, 5000, None)", address],
    { stdio: "ignore", timeout: 10_000, env: { PATH: "/usr/bin:/bin" } });
  for (let waited = 0; waited < 5_000 && !calls().length; waited += 50) await wait(50);
  if (!/OpenURI OpenURI \('', 'mailto:control@acme\.example'/.test(calls()[0] || "")) throw new Error(`the stand-in portal did not write down the call made to it: ${said}`);
  // The control call is not one a test asks about.
  const seen = calls().length;
  return { address, calls: () => calls().slice(seen) };
}

module.exports = { noBus, privateBus };
